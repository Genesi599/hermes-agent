"""Change-log feed: trigger coverage, watermark and resync semantics.

The change_log table (SCHEMA_SQL, schema v26) is appended by SQLite
triggers so EVERY writer is covered — including raw sqlite3 connections
from other processes (cron, dispatch scripts, CLI) that never go through
SessionDB. ``SessionDB.read_change_feed`` turns it into a monotonic
delta feed with a per-database generation and gap detection.
"""

import sqlite3

import pytest

from hermes_state import SessionDB


@pytest.fixture()
def db(tmp_path):
    session_db = SessionDB(db_path=tmp_path / "state.db")
    yield session_db
    session_db.close()


def _raw_writer(db_path):
    """A second, plain connection — the multi-writer proof."""
    conn = sqlite3.connect(str(db_path), timeout=10)
    try:
        yield conn
    finally:
        conn.close()


class TestTriggerCoverage:
    def test_raw_sqlite_writes_are_logged(self, db, tmp_path):
        # The whole point of triggers over app-level appends: an out-of
        # -process writer with no SessionDB knowledge still produces events.
        session_id = db.create_session("20260101_000000_probe", "cli")
        feed = db.read_change_feed()
        assert feed["resync"] is True  # bootstrap watermark
        watermark = feed["last_seq"]
        assert watermark >= 1

        raw = sqlite3.connect(str(tmp_path / "state.db"), timeout=10)
        try:
            raw.execute(
                "INSERT INTO messages (session_id, role, content, timestamp) "
                "VALUES (?, 'user', 'probe', 123.0)",
                (session_id,),
            )
            raw.execute(
                "UPDATE sessions SET message_count = message_count WHERE id = ?",
                (session_id,),
            )
            raw.commit()
        finally:
            raw.close()

        feed = db.read_change_feed(since=watermark)
        tables = [event["table"] for event in feed["events"]]
        assert tables.count("messages") >= 1
        assert tables.count("sessions") >= 1

    def test_delete_is_a_delete_event(self, db):
        session_id = db.create_session("20260101_000000_probe2", "cli")
        head = db.read_change_feed(since=0)["last_seq"]
        cur = db._conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) "
            "VALUES (?, 'user', 'gone', 1.0)",
            (session_id,),
        )
        message_id = cur.lastrowid
        db._conn.execute("DELETE FROM messages WHERE id = ?", (message_id,))
        db._conn.commit()

        feed = db.read_change_feed(since=head)
        deletes = [
            event
            for event in feed["events"]
            if event["kind"] == "delete" and event["table"] == "messages" and event["pk"] == str(message_id)
        ]
        assert deletes

    def test_generation_is_stable_across_reopen(self, db, tmp_path):
        first = db.read_change_feed()["generation"]
        db.close()

        reopened = SessionDB(db_path=tmp_path / "state.db")
        try:
            assert reopened.read_change_feed()["generation"] == first
        finally:
            reopened.close()


class TestFeedSemantics:
    def test_bootstrap_watermark_requests_resync(self, db):
        feed = db.read_change_feed(since=0)
        assert feed["resync"] is True
        assert feed["events"] == []

    def test_since_returns_only_newer_events_in_order(self, db):
        db.create_session("20260101_000000_a", "cli")
        head = db.read_change_feed()["last_seq"]
        db.create_session("20260101_000000_b", "cli")
        db.create_session("20260101_000000_c", "cli")

        feed = db.read_change_feed(since=head)
        assert feed["resync"] is False
        seqs = [event["seq"] for event in feed["events"]]
        assert seqs == sorted(seqs)
        assert all(seq > head for seq in seqs)
        assert feed["last_seq"] == max(seqs)

    def test_pruned_gap_forces_resync(self, db):
        db.create_session("20260101_000000_gap", "cli")
        # A client watermark the pruning later invalidates.
        stale_watermark = db.read_change_feed(since=0)["last_seq"]
        db.create_session("20260101_000000_gap2", "cli")
        db.create_session("20260101_000000_gap3", "cli")

        # Simulate retention pruning dropping the history the client still
        # needs: everything below the current head.
        head = db.read_change_feed(since=0)["last_seq"]
        db._conn.execute("DELETE FROM change_log WHERE seq <= ?", (head - 1,))
        db._conn.commit()

        feed = db.read_change_feed(since=stale_watermark)
        assert feed["resync"] is True
        assert feed["events"] == []
        assert feed["last_seq"] >= head

    def test_wiped_log_with_stale_watermark_forces_resync(self, db):
        db.create_session("20260101_000000_wipe", "cli")
        stale = db.read_change_feed(since=0)["last_seq"]

        db._conn.execute("DELETE FROM change_log")
        db._conn.commit()

        feed = db.read_change_feed(since=stale)
        assert feed["resync"] is True
        assert feed["last_seq"] == 0

    def test_limit_bounds_the_batch(self, db):
        for index in range(6):
            db.create_session(f"20260101_000000_l{index}", "cli")
        feed = db.read_change_feed(since=1, limit=2)
        assert len(feed["events"]) == 2
        assert feed["resync"] is False
