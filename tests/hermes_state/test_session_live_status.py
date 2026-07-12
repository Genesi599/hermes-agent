from hermes_state import SessionDB


def test_session_live_status_is_persisted_for_other_clients(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("shared-session", "desktop")

        db.set_session_live_status("shared-session", "working")
        working = db.get_session("shared-session")
        assert working["live_status"] == "working"
        assert working["live_status_updated_at"] is not None

        db.set_session_live_status("shared-session", "idle")
        assert db.get_session("shared-session")["live_status"] == "idle"
    finally:
        db.close()
