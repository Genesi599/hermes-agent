"""custom/hermes-yh: branch/duplicate model inheritance (2026-09-12).

Covers _inherited_model_overrides — the helper session.branch and the seeded
session.create path use so a child conversation inherits the parent's model
identity instead of falling back to the config default.
"""

from pathlib import Path

from hermes_state import SessionDB

from tui_gateway.methods_session import _inherited_model_overrides


def _make_db(tmp_path: Path) -> SessionDB:
    return SessionDB(db_path=tmp_path / "state.db")


def test_inherits_model_and_provider_config(tmp_path):
    db = _make_db(tmp_path)
    try:
        db.create_session(
            "20260912_000000_parent",
            source="desktop",
            model="deepseek-v4-flash",
            model_config={
                "provider": "deepseek_api",
                "base_url": "https://api.deepseek.com/v1",
                "reasoning_config": {"enabled": False},
                "_branched_from": "20260911_000000_grand",
                "_branch_seed_message_count": 7,
            },
        )

        got = _inherited_model_overrides(db, "20260912_000000_parent")

        assert got["model"] == "deepseek-v4-flash"
        cfg = got["model_config"]
        assert cfg["provider"] == "deepseek_api"
        assert cfg["base_url"] == "https://api.deepseek.com/v1"
        assert cfg["reasoning_config"] == {"enabled": False}
        # Lineage bookkeeping must NOT leak into the child's config.
        assert "_branched_from" not in cfg
        assert "_branch_seed_message_count" not in cfg
    finally:
        db.close()


def test_missing_row_returns_empty(tmp_path):
    db = _make_db(tmp_path)
    try:
        assert _inherited_model_overrides(db, "no-such-session") == {}
        assert _inherited_model_overrides(None, "anywhere") == {}
    finally:
        db.close()


def test_corrupt_model_config_json_still_inherits_model_column(tmp_path):
    db = _make_db(tmp_path)
    try:
        db.create_session("20260912_000001_src", source="desktop", model="kimi-k3")
        with db._lock:
            db._conn.execute(
                "UPDATE sessions SET model_config = ? WHERE id = ?",
                ("{not json", "20260912_000001_src"),
            )
            db._conn.commit()

        got = _inherited_model_overrides(db, "20260912_000001_src")
        assert got["model"] == "kimi-k3"
        assert got["model_config"] == {}
    finally:
        db.close()
