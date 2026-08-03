import os
import tempfile
import threading
import time
from types import SimpleNamespace

os.environ.setdefault("LOCALAPPDATA", tempfile.gettempdir())

from hermes_state import SessionDB
from tui_gateway import server


RPE_TITLES = [
    "RPE-01 经典衰老主题评分",
    "RPE-02 全局转录与通路方向",
    "RPE-03 细胞通讯与Non-protein审计",
    "RPE-04 转录因子调控网络",
    "RPE-05 IHC-Bulk-snRNA证据整合",
    "RPE-06 ESC-RPE验证方案",
]


def test_rpe_batch_end_to_end_persists_and_recovers(tmp_path, monkeypatch):
    db_path = tmp_path / "state.db"
    db = SessionDB(db_path=db_path)
    db.create_session(
        "rpe-parent",
        source="desktop",
        profile_name="default",
        model="test/model",
        model_config={"provider": "test"},
    )
    db.set_session_title("rpe-parent", "RPE Aging专项分析")
    db.append_message("rpe-parent", "user", "请并行分析 RPE aging。")
    db.append_message("rpe-parent", "assistant", "我会创建六个持久化 Conversation Branch。")

    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_conversation_branch_limits", lambda: (3, 4))
    monkeypatch.setattr(server, "_claim_active_session_slot", lambda *args, **kwargs: (None, None))
    monkeypatch.setattr(server, "_set_session_context", lambda *args, **kwargs: ())
    monkeypatch.setattr(server, "_clear_session_context", lambda _tokens: None)
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
            "running": False,
            "session_key": branch_id,
        }

    def submit(batch_id, client_key, runtime_sid, session, prompt, **kwargs):
        db.append_message(session["session_key"], "user", prompt)
        db.update_branch_run(
            batch_id,
            client_key,
            runtime_session_id=runtime_sid,
            started_at=time.time(),
            status="running",
        )

    monkeypatch.setattr(server, "_init_session", init)
    monkeypatch.setattr(server, "_submit_branch_prompt", submit)
    server._sessions.clear()
    server._sessions["runtime-parent"] = {
        "history_lock": threading.RLock(),
        "running": True,
        "session_key": "rpe-parent",
    }

    result = server._conversation_branches_action(
        "create_batch",
        {
            "branches": [
                {
                    "client_branch_key": f"rpe-{index}",
                    "initial_prompt": f"独立执行任务 {index}: {title}",
                    "title": title,
                }
                for index, title in enumerate(RPE_TITLES, start=1)
            ],
            "max_parallel": 3,
            "request_id": "rpe-six-branches",
        },
        "rpe-parent",
    )
    assert result["created_count"] == 0
    assert result["state"] == "pending_checkpoint"

    ids = iter(f"rpe-child-{index}" for index in range(1, 7))
    monkeypatch.setattr(server, "_new_session_key", lambda: next(ids))
    server._sessions["runtime-parent"]["running"] = False
    server._drain_pending_branch_batches("rpe-parent")

    batch = db.get_branch_batch(result["batch_id"])
    branch_ids = [run["branch_session_id"] for run in batch["branches"]]
    assert len(set(branch_ids)) == 6
    assert [db.get_session(branch_id)["title"] for branch_id in branch_ids] == RPE_TITLES
    assert {db.get_session(branch_id)["parent_session_id"] for branch_id in branch_ids} == {"rpe-parent"}
    statuses = [run["status"] for run in batch["branches"]]
    assert statuses.count("running") == 3
    assert statuses.count("queued") == 3
    for run in batch["branches"][:3]:
        messages = db.get_messages(run["branch_session_id"])
        assert messages[-1]["role"] == "user"
        assert messages[-1]["content"] == run["initial_prompt"]
        assert all(left["role"] != right["role"] for left, right in zip(messages, messages[1:]))

    completed = batch["branches"][0]
    db.append_message(completed["branch_session_id"], "assistant", "任务一完成。")
    db.update_branch_run(
        batch["batch_id"],
        completed["client_branch_key"],
        status="completed",
        completed_at=time.time(),
        result_summary="任务一完成。",
        runtime_session_id=None,
    )
    server._start_queued_branch_runs(batch["batch_id"])
    after_completion = db.get_branch_batch(batch["batch_id"])
    assert [run["status"] for run in after_completion["branches"]].count("running") == 3
    assert [run["status"] for run in after_completion["branches"]].count("queued") == 2

    cancelled = after_completion["branches"][1]
    server._conversation_branches_action(
        "cancel",
        {
            "branch_session_id": cancelled["branch_session_id"],
            "parent_session_id": "rpe-parent",
        },
        "rpe-parent",
    )
    assert db.get_branch_batch(batch["batch_id"])["branches"][1]["status"] == "cancelled"
    assert db.get_session("rpe-parent")["ended_at"] is None

    server._sessions.clear()
    db.close()
    reopened = SessionDB(db_path=db_path)
    try:
        reopened.recover_interrupted_branch_runs("default")
        restored = reopened.get_branch_batch(batch["batch_id"])
        assert len(restored["branches"]) == 6
        assert restored["branches"][0]["status"] == "completed"
        assert restored["branches"][1]["status"] == "cancelled"
        assert "running" not in {run["status"] for run in restored["branches"]}
    finally:
        reopened.close()
