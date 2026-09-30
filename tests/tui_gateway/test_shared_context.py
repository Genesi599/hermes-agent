"""SHARED CONTEXT SLOT (2026-09-29): the dispatched room context lives in ONE
per-session slot — composed onto the model input via _prepend_note, never
appended to the transcript. These tests cover store/restore round-trips."""

from pathlib import Path

from tui_gateway import server


def _session_with_home(tmp_path: Path, key: str = "20260928_102823_e68298") -> dict:
    session = {"session_key": key}
    original = server._session_home
    server._session_home = lambda s: tmp_path
    try:
        yield session
    finally:
        server._session_home = original


def test_write_then_note_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "_session_home", lambda s: tmp_path)
    session = {"session_key": "20260928_102823_e68298"}

    assert server._shared_context_note(session) == ""

    server.write_shared_context(session, "# 共享上下文 · 日常\n看板内容…")

    assert server._shared_context_note(session) == "# 共享上下文 · 日常\n看板内容…"


def test_sidecar_restores_cold_session(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "_session_home", lambda s: tmp_path)
    warm = {"session_key": "20260928_102823_e68298"}
    server.write_shared_context(warm, "BOARD STATE X")

    # A cold-resumed session dict carries no slot — the sidecar restores it.
    cold = {"session_key": "20260928_102823_e68298"}

    assert server._shared_context_note(cold) == "BOARD STATE X"
    assert cold["shared_context"] == "BOARD STATE X"


def test_empty_write_clears_slot_and_sidecar(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "_session_home", lambda s: tmp_path)
    session = {"session_key": "20260928_102823_e68298"}
    server.write_shared_context(session, "SOME CONTEXT")
    server.write_shared_context(session, "")

    assert server._shared_context_note(session) == ""
    sidecar = tmp_path / server._SHARED_CONTEXT_DIR / "20260928_102823_e68298.md"
    assert not sidecar.exists()


def test_missing_session_key_serves_dict_without_persisting(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "_session_home", lambda s: tmp_path)
    session = {"session_key": ""}

    # No key → no sidecar, but the live dict slot still serves the turn.
    server.write_shared_context(session, "ctx")

    assert server._shared_context_note(session) == "ctx"
    assert not (tmp_path / server._SHARED_CONTEXT_DIR).exists()
