# Tests for POST /api/sessions/{id}/prompt — the dialog-channel turn endpoint
# the cron scheduler uses for jobs bound to a conversation (attach_to_session).


import threading
import time
import types

import pytest
from starlette.testclient import TestClient


@pytest.fixture()
def gw(monkeypatch):
    """Stub the gateway symbols the endpoint's sync body uses.

    The endpoint imports ``tui_gateway.server`` lazily and reads module
    attributes, so monkeypatching the real module's attributes is both what
    it resolves and safe for the suite's module-state finalizer.
    """
    from tui_gateway import server as real_server

    fake = types.SimpleNamespace()
    fake.calls = {"run_prompt_submit": [], "enqueue": [], "model_switch": []}

    class _FakeDB:
        def resolve_resume_session_id(self, sid):
            return sid

        def get_session(self, sid):
            return {"id": sid}

    fake.db = _FakeDB()

    monkeypatch.setattr(real_server, "_get_db", lambda: fake.db)
    monkeypatch.setattr(
        real_server, "_find_live_session_by_key", lambda target: getattr(fake, "live", None)
    )
    monkeypatch.setattr(
        real_server,
        "_enqueue_prompt",
        lambda session, text, transport: fake.calls["enqueue"].append(text),
    )
    monkeypatch.setattr(
        real_server, "_schedule_queued_prompt_retry", lambda rid, sid, session: None
    )
    monkeypatch.setattr(
        real_server,
        "_apply_model_switch",
        lambda sid, session, raw, **kw: fake.calls["model_switch"].append(raw),
    )
    monkeypatch.setattr(
        real_server,
        "_run_prompt_submit",
        lambda rid, sid, session, text, **kw: fake.calls["run_prompt_submit"].append(
            (sid, text)
        ),
    )
    # Cold-start support: the endpoint builds the agent and may defer the
    # submit until the (fake, instantly-ready) build completes.
    monkeypatch.setattr(real_server, "_start_agent_build", lambda sid, session: None)
    monkeypatch.setattr(
        real_server, "_wait_agent_for_prompt", lambda session, rid, sid: None
    )

    yield fake


def _make_live(fake, running=False, agent_ready=True):
    session = {
        "history_lock": threading.Lock(),
        "running": running,
        "transport": object(),
        "session_key": "stored-1",
        "agent": object() if agent_ready else None,
    }
    fake.live = ("rt-1", session)
    return session


def _client():
    from hermes_cli import web_server as ws

    client = TestClient(ws.app)
    client.headers["X-Hermes-Session-Token"] = ws._SESSION_TOKEN
    return client


def test_prompt_requires_session_token():
    from hermes_cli import web_server as ws

    client = TestClient(ws.app)
    resp = client.post("/api/sessions/abc/prompt", json={"text": "hi"})
    assert resp.status_code == 401


def test_prompt_unknown_session_rejects(gw):
    gw.db = type("EmptyDB", (), {})()
    gw.db.resolve_resume_session_id = lambda sid: None
    gw.db.get_session = lambda sid: None
    client = _client()
    resp = client.post("/api/sessions/nope/prompt", json={"text": "hi"})
    assert resp.status_code == 404


def test_prompt_submits_through_run_prompt_submit(gw):
    _make_live(gw, running=False)
    client = _client()
    resp = client.post(
        "/api/sessions/stored-1/prompt",
        json={
            "text": "hello",
            "provider": "deepseek_api",
            "model": "deepseek-v4-flash",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "streaming"
    assert body["session_id"] == "rt-1"
    # The turn went through the standard gateway channel with the pinned
    # model applied as a one-turn switch.
    assert gw.calls["model_switch"] == [
        "deepseek-v4-flash --provider deepseek_api --once"
    ]
    assert gw.calls["run_prompt_submit"] == [("rt-1", "hello")]


def test_prompt_busy_queues_instead_of_rejecting(gw):
    _make_live(gw, running=True)
    client = _client()
    resp = client.post(
        "/api/sessions/stored-1/prompt", json={"text": "later", "queued": True}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "queued"
    assert gw.calls["enqueue"] == ["later"]
    assert gw.calls["run_prompt_submit"] == []


def test_prompt_busy_without_queued_flag_rejects(gw):
    _make_live(gw, running=True)
    client = _client()
    resp = client.post(
        "/api/sessions/stored-1/prompt", json={"text": "later", "queued": False}
    )
    assert resp.status_code == 409


def test_prompt_empty_text_rejects(gw):
    _make_live(gw, running=False)
    client = _client()
    resp = client.post("/api/sessions/stored-1/prompt", json={"text": "  "})
    assert resp.status_code == 400


def test_prompt_cold_session_defers_until_agent_ready(gw):
    session = _make_live(gw, running=False, agent_ready=False)
    client = _client()
    resp = client.post(
        "/api/sessions/stored-1/prompt", json={"text": "cold hello"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "deferred"
    # The background thread waits for the build then submits the turn.
    for _ in range(50):
        if gw.calls["run_prompt_submit"]:
            break
        time.sleep(0.02)
    assert gw.calls["run_prompt_submit"] == [("rt-1", "cold hello")]


def test_prompt_slash_command_routes_to_slash_exec(gw, monkeypatch):
    _make_live(gw, running=False)
    slash_calls = []
    monkeypatch.setattr(
        __import__("tui_gateway.server", fromlist=["x"]),
        "_methods",
        {
            "slash.exec": lambda rid, params: slash_calls.append(params)
            or {"jsonrpc": "2.0", "id": rid, "result": {"handled": True}}
        },
    )
    client = _client()
    resp = client.post(
        "/api/sessions/stored-1/prompt", json={"text": "/compress"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "slash"
    assert slash_calls == [{"session_id": "rt-1", "command": "compress"}]
    # A slash submit never reaches the turn channel.
    assert gw.calls["run_prompt_submit"] == []
