"""TOOL OUTPUT DOWNGRADE — stale tool outputs become one-line summaries."""

import json
import os
import tempfile
from pathlib import Path

import pytest

from hermes_state import (
    _summarize_tool_output,
    downgrade_stale_tool_outputs,
)


@pytest.fixture()
def tmp_db(tmp_path):
    """Create a minimal state.db with a messages table and some tool rows."""
    import sqlite3

    db = tmp_path / "state.db"
    con = sqlite3.connect(db)
    con.execute("""
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_name TEXT,
            compacted INTEGER DEFAULT 0
        )
    """)
    # 10 tool messages; the last 5 are protected (keep_last_n=5)
    for i in range(10):
        size = 100 if i < 3 else 5000  # first 3 small, rest large
        content = json.dumps({"output": f"line1 of output {i}\nline2\nline3", "exit_code": 0})
        content = content + "x" * max(0, size - len(content))
        con.execute(
            "INSERT INTO messages (session_id, role, content, tool_name) VALUES (?, 'tool', ?, ?)",
            ("test-session", content, "terminal" if i % 2 == 0 else "read_file"),
        )
    # A user message (should be untouched)
    con.execute(
        "INSERT INTO messages (session_id, role, content) VALUES (?, 'user', 'hello')",
        ("test-session",),
    )
    con.commit()
    con.close()
    return db


class TestDowngrade:
    def test_old_large_tools_downgraded(self, tmp_db):
        """Tool outputs older than keep_last_n and > min_bytes get summarized."""
        n = downgrade_stale_tool_outputs(tmp_db, "test-session", keep_last_n=5)
        # 10 tool messages, last 5 protected → 5 stale (IDs 1-5)
        # Of those, 3 are small (<400B) → only 2 large enough to downgrade
        assert n == 2

    def test_small_tools_untouched(self, tmp_db):
        """Tool outputs below min_bytes are not touched (not worth the churn)."""
        import sqlite3

        downgrade_stale_tool_outputs(tmp_db, "test-session", keep_last_n=5)
        con = sqlite3.connect(tmp_db)
        # The first 3 tool messages were small (100 bytes padded) → still original
        row = con.execute(
            "SELECT length(content) FROM messages WHERE session_id=? AND role='tool' ORDER BY id LIMIT 1",
            ("test-session",),
        ).fetchone()
        assert row[0] >= 100  # original content preserved (100B = exact fixture size)
        con.close()

    def test_recent_tools_protected(self, tmp_db):
        """The last keep_last_n tool messages are never downgraded."""
        import sqlite3

        downgrade_stale_tool_outputs(tmp_db, "test-session", keep_last_n=5)
        con = sqlite3.connect(tmp_db)
        row = con.execute(
            "SELECT length(content) FROM messages WHERE session_id=? AND role='tool' ORDER BY id DESC LIMIT 1",
            ("test-session",),
        ).fetchone()
        assert row[0] > 1000  # full content preserved
        con.close()

    def test_user_messages_untouched(self, tmp_db):
        """Only tool-role messages are downgraded."""
        import sqlite3

        downgrade_stale_tool_outputs(tmp_db, "test-session", keep_last_n=5)
        con = sqlite3.connect(tmp_db)
        row = con.execute(
            "SELECT content FROM messages WHERE session_id=? AND role='user'",
            ("test-session",),
        ).fetchone()
        assert row[0] == "hello"
        con.close()

    def test_compacted_untouched(self, tmp_db):
        """Already-compacted rows (compacted=1) are skipped."""
        import sqlite3

        con = sqlite3.connect(tmp_db)
        con.execute("UPDATE messages SET compacted=1 WHERE session_id=? AND role='tool' AND id <= 5", ("test-session",))
        con.commit()
        con.close()
        # With first 5 marked compacted, only IDs 6-7 are candidates (8-10 protected)
        n = downgrade_stale_tool_outputs(tmp_db, "test-session", keep_last_n=5)
        assert n == 0  # 6,7 were small (<400B), so nothing to downgrade


class TestSummarize:
    def test_json_output(self):
        content = json.dumps({"output": "# Header\nSome meaningful text here", "exit_code": 0})
        result = _summarize_tool_output(content, "terminal")
        assert "[terminal" in result
        assert "exit=0" in result
        assert "Some meaningful text" in result
        assert len(result) < 200

    def test_plain_text(self):
        result = _summarize_tool_output("plain output text\nmore lines", "read_file")
        assert "[read_file" in result
        assert "plain output text" in result

    def test_empty(self):
        result = _summarize_tool_output("", None)
        assert "(empty)" in result
