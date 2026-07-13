from __future__ import annotations

import threading
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture()
def server():
    with patch.dict(
        "sys.modules",
        {
            "hermes_constants": MagicMock(
                get_hermes_home=MagicMock(return_value="/tmp/hermes_test_scheduled_queue")
            ),
            "hermes_cli.env_loader": MagicMock(),
            "hermes_cli.banner": MagicMock(),
            "hermes_state": MagicMock(),
        },
    ):
        import importlib

        mod = importlib.import_module("tui_gateway.server")
        yield mod
        mod._sessions.clear()


def _session():
    return {
        "session_key": "desktop-session",
        "history": [{"role": "user", "content": "old"}],
        "history_version": 0,
        "history_lock": threading.Lock(),
        "running": False,
        "transport": None,
    }


def test_interactive_turn_waits_when_cron_owns_session(server, monkeypatch):
    db = MagicMock()
    db.get_session.return_value = {"id": "desktop-session"}
    db.try_claim_session_live_status.return_value = False
    monkeypatch.setattr(server, "_get_db", lambda: db)

    session = _session()
    assert server._try_claim_durable_session_turn("live-1", session) is False
    assert "_durable_turn_owner" not in session


def test_tui_durable_owner_contains_process_identity(server):
    owner = server._durable_turn_owner("live-1")
    parts = owner.split(":", 3)

    assert parts[0] == "tui"
    assert int(parts[1]) > 0
    assert int(parts[2]) >= 0
    assert parts[3] == "live-1"


def test_interactive_turn_marks_history_refresh_after_cron_release(server, monkeypatch):
    db = MagicMock()
    db.get_session.return_value = {
        "id": "desktop-session",
        "live_status": "idle",
        "live_status_owner": "cron:job:run",
    }
    db.try_claim_session_live_status.return_value = True
    monkeypatch.setattr(server, "_get_db", lambda: db)

    session = _session()
    assert server._try_claim_durable_session_turn("live-1", session) is True
    assert session["_refresh_external_history"] is True


def test_external_cron_messages_are_hydrated_before_next_turn(server, monkeypatch):
    db = MagicMock()
    db.get_session.return_value = {"id": "desktop-session", "message_count": 3}
    refreshed = [
        {"role": "user", "content": "old"},
        {"role": "user", "content": "scheduled"},
        {"role": "assistant", "content": "result"},
    ]
    db.get_messages_as_conversation.return_value = refreshed
    monkeypatch.setattr(server, "_get_db", lambda: db)

    session = _session()
    session["_refresh_external_history"] = True
    server._refresh_session_history_from_db(session)

    assert session["history"] == refreshed
    assert session["history_version"] == 1


def test_queued_prompt_stays_queued_until_session_lease_is_free(server, monkeypatch):
    session = _session()
    session["queued_prompt"] = {"text": "after cron", "transport": None}
    monkeypatch.setattr(
        server, "_try_claim_durable_session_turn", lambda sid, current: False
    )

    assert server._drain_queued_prompt("rid", "live-1", session) is False
    assert session["queued_prompt"]["text"] == "after cron"
    assert session["running"] is False
