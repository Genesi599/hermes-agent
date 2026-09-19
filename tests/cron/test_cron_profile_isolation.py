"""Regression tests for #4707 — cron must be per-profile.

Design intent (Teknium, June 2026): a profile's cron jobs both LIVE in that
profile's HERMES_HOME and EXECUTE under it.

- Storage: a job created under profile ``coder`` writes to
  ``~/.hermes/profiles/coder/cron/jobs.json`` — NOT the shared default root.
- Execution: the profile-scoped gateway's in-process ticker resolves the
  active HERMES_HOME (profile home) at call time, so jobs run with that
  profile's ``.env`` / ``config.yaml`` / scripts / skills.

This is the opposite direction from the (reverted) #50112/#32091 "anchor at the
shared root" approach. Anchoring at the root funnels every profile's jobs into
one store and runs them under whatever HERMES_HOME the ticker happens to have —
leaking config/credentials/skills across profiles, the security boundary #4707
was filed for. These tests pin per-profile isolation so a stale-branch merge or
a re-anchor "fix" can't silently flip it back.
"""
import importlib
from pathlib import Path


def _set_profile_env(monkeypatch, root: Path, profile_home: Path) -> None:
    """Pretend the platform default root is ``root`` and the active
    HERMES_HOME is a profile under it (``<root>/profiles/<name>``)."""
    import hermes_constants

    monkeypatch.setattr(
        hermes_constants, "_get_platform_default_hermes_home", lambda: root
    )
    monkeypatch.setenv("HERMES_HOME", str(profile_home))


def test_cron_storage_anchors_at_profile_home(tmp_path, monkeypatch):
    """Under a profile HERMES_HOME (<root>/profiles/<name>), the cron store
    resolves to <profile>/cron, NOT the shared <root>/cron."""
    root = tmp_path / "hermes_home"
    profile_home = root / "profiles" / "coder"
    profile_home.mkdir(parents=True)

    _set_profile_env(monkeypatch, root, profile_home)

    import hermes_constants

    # Sanity: the override is wired the way the gateway sees it.
    assert hermes_constants.get_hermes_home().resolve() == profile_home.resolve()
    assert hermes_constants.get_default_hermes_root().resolve() == root.resolve()

    # cron/jobs.py computes HERMES_DIR from get_hermes_home() at import, so a
    # fresh import under this env anchors the store at <profile>/cron.
    import cron.jobs as jobs

    importlib.reload(jobs)
    try:
        assert jobs.HERMES_DIR.resolve() == profile_home.resolve()
        assert (
            jobs.JOBS_FILE.resolve()
            == (profile_home / "cron" / "jobs.json").resolve()
        )
        # The shared-root path must NOT be the store — that would re-break
        # per-profile isolation (#4707).
        assert (
            jobs.JOBS_FILE.resolve() != (root / "cron" / "jobs.json").resolve()
        )
    finally:
        monkeypatch.undo()
        importlib.reload(jobs)




def _write_jobs_file(path: Path, payload) -> None:
    import json
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_mark_job_run_falls_back_to_root_store(tmp_path):
    """A job DEFINED in the root store but EXECUTED under its agent_profile's
    home (per-job profile scope) must still get its run mark written back to
    the root store — the profile store has no copy of the definition, and
    dropping the mark left last_run_at stale forever."""
    import json

    root = tmp_path / "root"
    profile_home = root / "profiles" / "steward"
    job = {
        "id": "j1",
        "name": "投递-管家",
        "schedule": {"kind": "cron", "expr": "*/5 * * * *"},
        "enabled": True,
        "state": "scheduled",
        "agent_profile": "steward",
        "fire_claim": {"at": "x", "by": "y"},
    }
    _write_jobs_file(root / "cron" / "jobs.json", {"jobs": [job]})
    profile_home.mkdir(parents=True)  # profile cron store stays empty

    import cron.jobs as jobs

    with jobs.use_cron_store(profile_home):
        assert jobs.mark_job_run("j1", True) is True

    marked = json.loads((root / "cron" / "jobs.json").read_text(encoding="utf-8"))["jobs"][0]
    assert marked["last_status"] == "ok"
    assert marked["last_run_at"]
    assert marked["next_run_at"] is not None
    assert marked["fire_claim"] is None


def test_mark_job_run_unknown_id_stays_false(tmp_path):
    import json

    root = tmp_path / "root"
    profile_home = root / "profiles" / "steward"
    profile_home.mkdir(parents=True)
    _write_jobs_file(root / "cron" / "jobs.json", {"jobs": []})

    import cron.jobs as jobs

    with jobs.use_cron_store(profile_home):
        assert jobs.mark_job_run("nope", True) is False


def test_mark_job_run_prefers_active_profile_store(tmp_path):
    """The fallback must not flip #4707 isolation: a job DEFINED in the
    profile's own store is marked there, and the root store stays untouched."""
    import json

    root = tmp_path / "root"
    profile_home = root / "profiles" / "coder"
    root_job = {"id": "rootjob", "schedule": {"kind": "cron", "expr": "* * * * *"}, "enabled": True}
    profile_job = {"id": "profjob", "schedule": {"kind": "cron", "expr": "* * * * *"}, "enabled": True}
    _write_jobs_file(root / "cron" / "jobs.json", {"jobs": [root_job]})
    _write_jobs_file(profile_home / "cron" / "jobs.json", {"jobs": [profile_job]})

    import cron.jobs as jobs

    with jobs.use_cron_store(profile_home):
        assert jobs.mark_job_run("profjob", True) is True

    assert "last_run_at" in json.loads(
        (profile_home / "cron" / "jobs.json").read_text(encoding="utf-8")
    )["jobs"][0]
    assert "last_run_at" not in json.loads(
        (root / "cron" / "jobs.json").read_text(encoding="utf-8")
    )["jobs"][0]
