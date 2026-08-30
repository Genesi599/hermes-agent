"""WS reconnect must re-own sessions parked on the detached drop sink.

2026-08-30 incident: after a backend restart + one WS drop, running sessions
stayed parked on ``_detached_ws_transport`` (pure drop sink, reap-exempt while
running) and no new connection ever re-bound them — turns executed, frames
vanished. These tests pin the two fixes: ``rebind_detached_sessions`` on new
WS connect, and desktop-mode stdio fall-through for parked-session frames.
"""

from unittest.mock import MagicMock

import pytest

from tui_gateway import server


@pytest.fixture()
def clean_sessions():
    """Isolate the module-level session registry and stdio sink per test."""
    saved_sessions = dict(server._sessions)
    saved_stdio = server._stdio_transport
    server._sessions.clear()
    yield
    server._sessions.clear()
    server._sessions.update(saved_sessions)
    server._stdio_transport = saved_stdio


def _parked_session(sid: str, running: bool = True) -> dict:
    session = {"agent": MagicMock(), "session_key": sid, "running": running}
    server._sessions[sid] = session
    return session


class TestRebindDetachedSessions:
    def test_parked_sessions_rebound_to_new_transport(self, clean_sessions):
        parked = _parked_session("sess_parked")
        parked["transport"] = server._detached_ws_transport

        new_transport = MagicMock()
        count = server.rebind_detached_sessions(new_transport, peer="t-test")

        assert count == 1
        assert parked["transport"] is new_transport

    def test_live_and_unbound_sessions_untouched(self, clean_sessions):
        live = _parked_session("sess_live")
        live_transport = MagicMock()
        live["transport"] = live_transport
        unbound = _parked_session("sess_unbound")
        unbound["transport"] = None

        new_transport = MagicMock()
        count = server.rebind_detached_sessions(new_transport)

        assert count == 0
        assert live["transport"] is live_transport
        assert unbound["transport"] is None

    def test_none_transport_is_noop(self, clean_sessions):
        assert server.rebind_detached_sessions(None) == 0

    def test_rebound_session_no_longer_orphaned(self, clean_sessions):
        """Scheduled orphan reaps must self-cancel after a rebind."""
        parked = _parked_session("sess_reap", running=False)
        parked["transport"] = server._detached_ws_transport
        assert server._ws_session_is_orphaned(parked) is True

        server.rebind_detached_sessions(MagicMock())

        assert server._ws_session_is_orphaned(parked) is False


class TestWriteJsonDetachedRouting:
    def _event_frame(self, sid: str) -> dict:
        return {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {"type": "message.delta", "session_id": sid, "payload": {}},
        }

    def test_desktop_mode_detached_frame_falls_through_to_stdio(
        self, clean_sessions, monkeypatch
    ):
        monkeypatch.setenv("HERMES_DESKTOP", "1")
        monkeypatch.delenv("HERMES_DESKTOP_TERMINAL", raising=False)
        parked = _parked_session("sess_desktop")
        parked["transport"] = server._detached_ws_transport
        stdio = MagicMock()
        stdio.write.return_value = True
        monkeypatch.setattr(server, "_stdio_transport", stdio)

        frame = self._event_frame("sess_desktop")
        assert server.write_json(frame) is True
        stdio.write.assert_called_once_with(frame)

    def test_tui_mode_detached_frame_still_dropped(
        self, clean_sessions, monkeypatch
    ):
        monkeypatch.delenv("HERMES_DESKTOP", raising=False)
        parked = _parked_session("sess_tui")
        parked["transport"] = server._detached_ws_transport
        stdio = MagicMock()
        monkeypatch.setattr(server, "_stdio_transport", stdio)

        frame = self._event_frame("sess_tui")
        assert server.write_json(frame) is False
        stdio.write.assert_not_called()

    def test_rebound_session_frame_routed_to_new_owner(self, clean_sessions):
        parked = _parked_session("sess_rebound")
        parked["transport"] = server._detached_ws_transport
        new_transport = MagicMock()
        new_transport.write.return_value = True
        server.rebind_detached_sessions(new_transport)

        frame = self._event_frame("sess_rebound")
        assert server.write_json(frame) is True
        new_transport.write.assert_called_once_with(frame)
