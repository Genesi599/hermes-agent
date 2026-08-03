import os
import tempfile
import threading
from types import SimpleNamespace

import pytest

os.environ.setdefault("LOCALAPPDATA", tempfile.gettempdir())

from hermes_state import SessionDB
from tui_gateway import server


@pytest.fixture
def db(tmp_path, monkeypatch):
    store = SessionDB(db_path=tmp_path / "state.db")
    monkeypatch.setattr(server, "_get_db", lambda: store)
    monkeypatch.setattr(server, "_conversation_branch_limits", lambda: (3, 4))
    server._sessions.clear()
    yield store
    server._sessions.clear()
    store.close()


def _parent(db, session_id="parent", profile="default"):
    db.create_session(
        session_id,
        source="desktop",
        profile_name=profile,
        model="test/model",
        model_config={"provider": "test"},
    )
    db.append_message(session_id, "user", "question")
    db.append_message(session_id, "assistant", "answer")
    return db.get_session(session_id)


def _branches(count=6, *, auto_start=False):
    return [
        {
            "auto_start": auto_start,
            "client_branch_key": f"task-{index}",
            "initial_prompt": f"prompt-{index}",
            "title": f"Branch {index}",
        }
        for index in range(1, count + 1)
    ]


def _children(db, parent_id):
    return [
        session
        for session in db.list_sessions_rich(
            include_children=True,
            include_named_empty=True,
            limit=100,
        )
        if session.get("parent_session_id") == parent_id
    ]


def test_running_parent_defers_then_idle_boundary_creates_six(db, monkeypatch):
    _parent(db)
    server._sessions["runtime-parent"] = {
        "history_lock": threading.RLock(),
        "running": True,
        "session_key": "parent",
    }

    result = server._conversation_branches_action(
        "create_batch",
        {
            "branches": _branches(),
            "max_parallel": 6,
            "request_id": "running-parent",
        },
        "parent",
    )

    assert result["state"] == "pending_checkpoint"
    assert result["created_count"] == 0
    assert _children(db, "parent") == []

    server._sessions["runtime-parent"]["running"] = False
    ids = iter(f"child-{index}" for index in range(1, 7))
    monkeypatch.setattr(server, "_new_session_key", lambda: next(ids))
    server._drain_pending_branch_batches("parent")

    batch = db.get_branch_batch(result["batch_id"])
    children = _children(db, "parent")
    assert len(children) == 6
    assert {child["parent_session_id"] for child in children} == {"parent"}
    assert {run["status"] for run in batch["branches"]} == {"paused"}
    assert batch["checkpoint_message_id"] == db.get_messages("parent")[-1]["id"]
    assert db.get_session("parent")["ended_at"] is None


def test_explicit_checkpoint_excludes_later_parent_turns(db, monkeypatch):
    _parent(db)
    checkpoint_id = db.get_messages("parent")[-1]["id"]
    db.append_message("parent", "user", "later question")
    db.append_message("parent", "assistant", "later answer")
    server._sessions["runtime-parent"] = {
        "history_lock": threading.RLock(),
        "running": False,
        "session_key": "parent",
    }
    monkeypatch.setattr(server, "_new_session_key", lambda: "checkpoint-child")

    result = server._conversation_branches_action(
        "create_batch",
        {
            "branch_point_message_id": checkpoint_id,
            "branches": _branches(1),
            "request_id": "explicit-checkpoint",
        },
        "parent",
    )

    child_id = result["branches"][0]["branch_session_id"]
    assert [message["content"] for message in db.get_messages(child_id)] == ["question", "answer"]


def test_max_parallel_starts_only_available_capacity(db, monkeypatch):
    _parent(db)
    batch = db.create_branch_batch(
        batch_id="parallel",
        profile_name="default",
        parent_session_id="parent",
        request_id="parallel",
        max_parallel=2,
        branches=_branches(4, auto_start=True),
    )
    for index, run in enumerate(batch["branches"], start=1):
        child_id = f"parallel-child-{index}"
        db.create_session(child_id, source="desktop", parent_session_id="parent", profile_name="default")
        db.update_branch_run(
            "parallel",
            run["client_branch_key"],
            branch_session_id=child_id,
            status="queued",
        )

    started = []
    monkeypatch.setattr(server, "_claim_active_session_slot", lambda *args, **kwargs: (None, None))
    monkeypatch.setattr(
        server,
        "_make_agent",
        lambda runtime_sid, branch_id, **kwargs: SimpleNamespace(session_id=branch_id),
    )

    def init(runtime_sid, branch_id, agent, history, **kwargs):
        server._sessions[runtime_sid] = {
            "agent": agent,
            "history": history,
            "history_lock": threading.RLock(),
            "session_key": branch_id,
        }

    monkeypatch.setattr(server, "_init_session", init)
    monkeypatch.setattr(server, "_set_session_context", lambda *args, **kwargs: ())
    monkeypatch.setattr(server, "_clear_session_context", lambda _tokens: None)
    monkeypatch.setattr(
        server,
        "_submit_branch_prompt",
        lambda batch_id, client_key, sid, session, prompt, **kwargs: started.append(client_key),
    )

    server._start_queued_branch_runs("parallel")

    assert len(started) == 2
    statuses = [run["status"] for run in db.get_branch_batch("parallel")["branches"]]
    assert statuses.count("running") == 2
    assert statuses.count("queued") == 2


def test_cancel_targets_only_selected_branch(db):
    _parent(db)
    batch = db.create_branch_batch(
        batch_id="cancel",
        profile_name="default",
        parent_session_id="parent",
        request_id="cancel",
        max_parallel=2,
        branches=_branches(2, auto_start=True),
    )
    for index, run in enumerate(batch["branches"], start=1):
        child_id = f"cancel-child-{index}"
        runtime_id = f"runtime-{index}"
        db.create_session(child_id, source="desktop", parent_session_id="parent", profile_name="default")
        db.update_branch_run(
            "cancel",
            run["client_branch_key"],
            branch_session_id=child_id,
            runtime_session_id=runtime_id,
            status="running",
        )
        server._sessions[runtime_id] = {
            "agent": SimpleNamespace(interrupt=lambda: None),
            "running": True,
            "session_key": child_id,
        }

    server._conversation_branches_action(
        "cancel",
        {"branch_session_id": "cancel-child-1", "parent_session_id": "parent"},
        "parent",
    )

    runs = {run["branch_session_id"]: run for run in db.get_branch_batch("cancel")["branches"]}
    assert runs["cancel-child-1"]["status"] == "cancelled"
    assert runs["cancel-child-2"]["status"] == "running"


def test_cross_profile_parent_operation_is_rejected(db):
    _parent(db)
    _parent(db, "other", "research")
    server._sessions["runtime-other"] = {
        "running": False,
        "session_key": "other",
    }

    with pytest.raises(PermissionError, match="cross-profile"):
        server._conversation_branches_action(
            "create_batch",
            {
                "branches": _branches(1),
                "parent_session_id": "parent",
                "request_id": "cross-profile",
            },
            "other",
        )
