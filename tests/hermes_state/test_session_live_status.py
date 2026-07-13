from hermes_state import (
    SESSION_LIVE_STATUS_STALE_SECONDS,
    SessionDB,
    session_live_status_is_working,
)


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


def test_session_live_status_lease_serializes_owners(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("shared-session", "desktop")

        assert db.try_claim_session_live_status("shared-session", "tui:one") is True
        assert db.try_claim_session_live_status("shared-session", "cron:job") is False
        assert db.release_session_live_status("shared-session", "cron:job") is False
        assert db.get_session("shared-session")["live_status"] == "working"

        assert db.release_session_live_status("shared-session", "tui:one") is True
        assert db.try_claim_session_live_status("shared-session", "cron:job") is True
        row = db.get_session("shared-session")
        assert row["live_status"] == "working"
        assert row["live_status_owner"] == "cron:job"
    finally:
        db.close()


def test_stale_session_live_status_lease_can_be_reclaimed(tmp_path, monkeypatch):
    now = [1_700_000_000.0]
    monkeypatch.setattr("hermes_state.time.time", lambda: now[0])
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("shared-session", "desktop")

        assert db.try_claim_session_live_status("shared-session", "tui:old") is True
        assert db.try_claim_session_live_status("shared-session", "tui:new") is False

        now[0] += SESSION_LIVE_STATUS_STALE_SECONDS + 1

        assert db.try_claim_session_live_status("shared-session", "tui:new") is True
        row = db.get_session("shared-session")
        assert row["live_status"] == "working"
        assert row["live_status_owner"] == "tui:new"
        assert db.release_session_live_status("shared-session", "tui:old") is False
    finally:
        db.close()


def test_dead_tui_process_lease_is_immediately_idle_and_reclaimable(
    tmp_path, monkeypatch
):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("shared-session", "desktop")
        old_owner = "tui:1234:5678:old-runtime"
        new_owner = "tui:4321:8765:new-runtime"

        monkeypatch.setattr(
            "hermes_state._tui_live_status_owner_process_alive",
            lambda owner: False if owner == old_owner else True,
        )
        assert db.try_claim_session_live_status("shared-session", old_owner) is True
        row = db.get_session("shared-session")
        assert session_live_status_is_working(row) is False

        assert db.try_claim_session_live_status("shared-session", new_owner) is True
        row = db.get_session("shared-session")
        assert row["live_status_owner"] == new_owner
        assert session_live_status_is_working(row) is True
    finally:
        db.close()


def test_live_tui_process_lease_still_blocks_other_owners(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("shared-session", "desktop")
        owner = "tui:1234:5678:live-runtime"
        monkeypatch.setattr(
            "hermes_state._tui_live_status_owner_process_alive", lambda _owner: True
        )

        assert db.try_claim_session_live_status("shared-session", owner) is True
        assert session_live_status_is_working(db.get_session("shared-session")) is True
        assert (
            db.try_claim_session_live_status(
                "shared-session", "tui:4321:8765:other-runtime"
            )
            is False
        )
    finally:
        db.close()
