import json
import os
import tempfile

import pytest

# scripts/run_tests.sh intentionally runs with a clean environment. Windows'
# Path.home() cannot resolve without either USERPROFILE or LOCALAPPDATA.
os.environ.setdefault("LOCALAPPDATA", tempfile.gettempdir())

from hermes_state import SessionDB
from tui_gateway.conversation_branches import (
    branch_batch_public_payload,
    fork_conversation_session,
    normalize_branch_specs,
    validate_parent_lineage,
)


@pytest.fixture
def db(tmp_path):
    store = SessionDB(db_path=tmp_path / "state.db")
    yield store
    store.close()


@pytest.fixture
def parent(db, tmp_path):
    db.create_session(
        "parent",
        source="desktop",
        model="parent-model",
        model_config={"provider": "parent-provider", "reasoning_config": {"effort": "high"}},
        profile_name="default",
        cwd=str(tmp_path),
    )
    db.append_message("parent", "user", "shared question")
    db.append_message("parent", "assistant", "shared answer")
    return db.get_session("parent")


def six_specs():
    return normalize_branch_specs(
        [
            {
                "client_branch_key": f"rpe-{index}",
                "title": f"RPE-{index:02d}",
                "initial_prompt": f"independent task {index}",
            }
            for index in range(1, 7)
        ]
    )


def create_six(db, parent):
    specs = six_specs()
    batch = db.create_branch_batch(
        batch_id="batch-1",
        profile_name="default",
        parent_session_id=parent["id"],
        request_id="request-1",
        max_parallel=3,
        branches=specs,
    )
    db.set_branch_batch_checkpoint("batch-1", 2)
    checkpoint = db.get_messages(parent["id"])
    for index, run in enumerate(db.get_branch_batch("batch-1")["branches"], start=1):
        child_id = f"child-{index}"
        fork_conversation_session(
            db=db,
            parent=parent,
            checkpoint=checkpoint,
            branch_session_id=child_id,
            title=run["title"],
            runtime_options={**run, "batch_id": "batch-1"},
        )
        db.update_branch_run(
            "batch-1",
            run["client_branch_key"],
            branch_session_id=child_id,
            status="queued",
        )
    return db.get_branch_batch(batch["batch_id"])


def test_creates_six_durable_siblings_from_one_checkpoint(db, parent):
    batch = create_six(db, parent)
    payload = branch_batch_public_payload(batch)
    assert payload["created_count"] == 6
    assert payload["queued_count"] == 6
    assert db.get_session("parent")["ended_at"] is None

    checkpoint = db.get_messages("parent")
    child_ids = [item["branch_session_id"] for item in batch["branches"]]
    assert len(set(child_ids)) == 6
    for child_id in child_ids:
        child = db.get_session(child_id)
        config = json.loads(child["model_config"])
        assert child["parent_session_id"] == "parent"
        assert config["_branched_from"] == "parent"
        assert db.get_messages(child_id) == [
            {**message, "id": db.get_messages(child_id)[index]["id"], "session_id": child_id}
            for index, message in enumerate(checkpoint)
        ]


def test_each_initial_prompt_is_metadata_until_its_own_turn_starts(db, parent):
    batch = create_six(db, parent)
    prompts = {item["initial_prompt"] for item in batch["branches"]}
    assert len(prompts) == 6
    for item in batch["branches"]:
        contents = [message["content"] for message in db.get_messages(item["branch_session_id"])]
        assert item["initial_prompt"] not in contents
        assert not prompts.intersection(contents)


def test_checkpoint_keeps_role_alternation(db, parent):
    batch = create_six(db, parent)
    for item in batch["branches"]:
        roles = [message["role"] for message in db.get_messages(item["branch_session_id"])]
        assert all(left != right for left, right in zip(roles, roles[1:]))


def test_request_id_is_idempotent(db, parent):
    specs = six_specs()
    first = db.create_branch_batch(
        batch_id="batch-original",
        profile_name="default",
        parent_session_id="parent",
        request_id="same-request",
        max_parallel=2,
        branches=specs,
    )
    second = db.create_branch_batch(
        batch_id="batch-retry",
        profile_name="default",
        parent_session_id="parent",
        request_id="same-request",
        max_parallel=6,
        branches=specs,
    )
    assert first["batch_id"] == second["batch_id"] == "batch-original"
    assert len(second["branches"]) == 6


def test_duplicate_client_key_is_rejected():
    with pytest.raises(ValueError, match="duplicate client_branch_key"):
        normalize_branch_specs(
            [
                {"client_branch_key": "same", "title": "one", "initial_prompt": "one"},
                {"client_branch_key": "same", "title": "two", "initial_prompt": "two"},
            ]
        )


def test_shared_unique_outputs_rejects_collisions():
    with pytest.raises(ValueError, match="duplicate output_dir"):
        normalize_branch_specs(
            [
                {
                    "client_branch_key": "a",
                    "title": "a",
                    "initial_prompt": "a",
                    "workspace_mode": "shared_unique_outputs",
                    "output_dir": "results/a",
                },
                {
                    "client_branch_key": "b",
                    "title": "b",
                    "initial_prompt": "b",
                    "workspace_mode": "shared_unique_outputs",
                    "output_dir": "RESULTS/A",
                },
            ]
        )


def test_git_worktree_requires_distinct_prepared_cwds():
    with pytest.raises(ValueError, match="prepared Desktop worktree"):
        normalize_branch_specs(
            [
                {
                    "client_branch_key": "a",
                    "title": "a",
                    "initial_prompt": "a",
                    "workspace_mode": "git_worktree",
                }
            ]
        )
    with pytest.raises(ValueError, match="duplicate git worktree cwd"):
        normalize_branch_specs(
            [
                {
                    "client_branch_key": "a",
                    "title": "a",
                    "initial_prompt": "a",
                    "workspace_mode": "git_worktree",
                    "cwd": "C:/repo/worktree-a",
                },
                {
                    "client_branch_key": "b",
                    "title": "b",
                    "initial_prompt": "b",
                    "workspace_mode": "git_worktree",
                    "cwd": "c:/REPO/worktree-A",
                },
            ]
        )


def test_batch_count_bounds_are_enforced():
    with pytest.raises(ValueError, match="between 1 and 10"):
        normalize_branch_specs([])
    with pytest.raises(ValueError, match="between 1 and 10"):
        normalize_branch_specs(
            [
                {"client_branch_key": str(index), "title": str(index), "initial_prompt": str(index)}
                for index in range(11)
            ]
        )


def test_parent_cycles_and_depth_are_rejected(db, parent):
    db.create_session("child", source="desktop", parent_session_id="parent")
    db._execute_write(
        lambda conn: conn.execute(
            "UPDATE sessions SET parent_session_id = 'child' WHERE id = 'parent'"
        )
    )
    with pytest.raises(ValueError, match="cycle"):
        validate_parent_lineage(db, "child", max_depth=10)


def test_running_work_recovers_as_interrupted_without_replay(db, parent):
    db.create_branch_batch(
        batch_id="batch-recovery",
        profile_name="default",
        parent_session_id="parent",
        request_id="recovery",
        max_parallel=1,
        branches=six_specs()[:1],
    )
    db.update_branch_run("batch-recovery", "rpe-1", status="running", runtime_session_id="runtime")
    assert db.recover_interrupted_branch_runs("default") == 1
    run = db.get_branch_batch("batch-recovery")["branches"][0]
    assert run["status"] == "interrupted"
    assert run["runtime_session_id"] is None


def test_one_run_failure_does_not_change_siblings(db, parent):
    batch = create_six(db, parent)
    first, second = batch["branches"][:2]
    db.update_branch_run("batch-1", first["client_branch_key"], status="failed", error="boom")
    refreshed = db.get_branch_batch("batch-1")["branches"]
    by_key = {item["client_branch_key"]: item for item in refreshed}
    assert by_key[first["client_branch_key"]]["status"] == "failed"
    assert by_key[second["client_branch_key"]]["status"] == "queued"


def test_fork_failure_removes_partial_child(db, parent, monkeypatch):
    original_append = db.append_message

    def fail_for_child(session_id, *args, **kwargs):
        if session_id == "broken-child":
            raise RuntimeError("copy failed")
        return original_append(session_id, *args, **kwargs)

    monkeypatch.setattr(db, "append_message", fail_for_child)
    with pytest.raises(RuntimeError, match="copy failed"):
        fork_conversation_session(
            db=db,
            parent=parent,
            checkpoint=db.get_messages("parent"),
            branch_session_id="broken-child",
            title="broken",
            runtime_options={},
        )
    assert db.get_session("broken-child") is None


def test_public_batch_payload_never_contains_prompts_or_transcripts(db, parent):
    batch = db.create_branch_batch(
        batch_id="public",
        profile_name="default",
        parent_session_id="parent",
        request_id="public",
        max_parallel=1,
        branches=six_specs()[:1],
    )
    payload = branch_batch_public_payload(batch)
    encoded = json.dumps(payload)
    assert "initial_prompt" not in encoded
    assert "independent task" not in encoded
    assert "messages" not in encoded


def test_same_request_id_is_scoped_by_parent_and_profile(db, parent):
    db.create_session("other-parent", source="desktop", profile_name="research")
    first = db.create_branch_batch(
        batch_id="scope-default",
        profile_name="default",
        parent_session_id="parent",
        request_id="same",
        max_parallel=1,
        branches=six_specs()[:1],
    )
    second = db.create_branch_batch(
        batch_id="scope-research",
        profile_name="research",
        parent_session_id="other-parent",
        request_id="same",
        max_parallel=1,
        branches=six_specs()[:1],
    )
    assert first["batch_id"] != second["batch_id"]


def test_default_profile_recovery_includes_legacy_empty_profile(db, parent):
    db.create_branch_batch(
        batch_id="legacy-default",
        profile_name="",
        parent_session_id="parent",
        request_id="legacy-default",
        max_parallel=1,
        branches=six_specs()[:1],
    )
    db.update_branch_run("legacy-default", "rpe-1", status="running")
    assert db.recover_interrupted_branch_runs("default") == 1
    assert db.get_branch_batch("legacy-default")["branches"][0]["status"] == "interrupted"


def test_batch_survives_database_reopen(tmp_path):
    path = tmp_path / "state.db"
    db = SessionDB(db_path=path)
    db.create_session("parent", source="desktop", profile_name="default")
    db.create_branch_batch(
        batch_id="durable",
        profile_name="default",
        parent_session_id="parent",
        request_id="durable-request",
        max_parallel=2,
        branches=six_specs(),
    )
    db.close()
    reopened = SessionDB(db_path=path)
    try:
        assert len(reopened.get_branch_batch("durable")["branches"]) == 6
    finally:
        reopened.close()
