"""Cold-boot probe for a Hermes `serve` backend (Phase 0 baseline tool).

Spawns `hermes serve` under a THROWAWAY profile, measures how long each boot
stage takes, samples the process tree's memory, then kills everything it
started. Never touches real profiles: it always uses profile name
``__bootprobe__`` (created under profiles/, deleted by ``--cleanup``).

Stages measured (local monotonic clock from spawn):
  t_tcp     - first successful TCP connect to the API port
  t_http    - first HTTP response of any kind (401 counts: the listener is up)
  t_cron    - backend log line "cron scheduler started" (boot tail marker)

Usage (repo root):

    venv/Scripts/python.exe -X utf8 scripts/cold_boot_probe.py [--runs 3] [--keep] [--cleanup]

``--keep`` leaves stderr logs in tmp-bootprobe-<n>.log for inspection;
``--cleanup`` just removes the throwaway profile directory and exits.
"""

from __future__ import annotations

import argparse
import os
import socket
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VENV_PY = REPO / "venv" / "Scripts" / "python.exe"
PROFILE = "bootprobe"
HERMES_ROOT = Path.home() / "AppData" / "Local" / "hermes"
PROFILE_DIR = HERMES_ROOT / "profiles" / PROFILE
PORT = 18971
HOST = "127.0.0.1"
BOOT_TAIL_MARKERS = ("HERMES_BACKEND_READY",)  # the exact line Electron waits for


def tcp_up(timeout: float = 0.2) -> bool:
    try:
        with socket.create_connection((HOST, PORT), timeout=timeout):
            return True
    except OSError:
        return False


def http_up() -> bool:
    try:
        urllib.request.urlopen(f"http://{HOST}:{PORT}/", timeout=0.5)
        return True
    except urllib.error.HTTPError:
        return True  # any HTTP status means the listener answers
    except Exception:
        return False


def kill_tree(pid: int) -> None:
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)


def one_run(idx: int, keep_log: bool) -> dict[str, float | None]:
    log_path = REPO / f"tmp-bootprobe-{idx}.log"
    log_file = open(log_path, "wb")
    # Match the Electron spawn contract: HERMES_DESKTOP=1 exempts the backend
    # from the machine-dashboard reroute (hermes_cli/main.py cmd_dashboard),
    # so the probe measures the true per-profile desktop boot path.
    child_env = {**os.environ, "HERMES_DESKTOP": "1"}
    t0 = time.perf_counter()
    proc = subprocess.Popen(
        [
            str(VENV_PY),
            "-m",
            "hermes_cli.main",
            "--profile",
            PROFILE,
            "serve",
            "--host",
            HOST,
            "--port",
            str(PORT),
        ],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        cwd=str(REPO),
        env=child_env,
    )
    t_tcp = t_http = t_cron = None
    try:
        deadline = time.perf_counter() + 45
        while time.perf_counter() < deadline:
            if t_tcp is None and tcp_up():
                t_tcp = time.perf_counter() - t0
            if t_tcp is not None and t_http is None and http_up():
                t_http = time.perf_counter() - t0
            if t_http is not None and t_cron is None:
                log_file.flush()
                text = log_path.read_bytes().decode("utf-8", "replace")
                if any(m in text for m in BOOT_TAIL_MARKERS):
                    t_cron = time.perf_counter() - t0
            if t_cron is not None:
                break
            time.sleep(0.05)
        try:
            import psutil

            parent = psutil.Process(proc.pid)
            total = parent.memory_info().rss + sum(
                c.memory_info().rss for c in parent.children(recursive=True)
            )
            rss = total / (1024 * 1024.0)
        except Exception:
            rss = None
        return {"t_tcp": t_tcp, "t_http": t_http, "t_cron": t_cron, "rss_mb": rss, "pid": proc.pid}
    finally:
        kill_tree(proc.pid)
        log_file.close()
        if not keep_log:
            log_path.unlink(missing_ok=True)


def fmt(v: float | None) -> str:
    return f"{v:6.2f}s" if v is not None else "  n/a "


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()

    if args.cleanup:
        import shutil

        shutil.rmtree(PROFILE_DIR, ignore_errors=True)
        wrapper = Path.home() / ".local" / "bin" / f"{PROFILE}.bat"
        wrapper.unlink(missing_ok=True)
        print(f"removed {PROFILE_DIR} (+ wrapper {wrapper})")
        return 0

    if not VENV_PY.exists():
        print(f"venv python not found: {VENV_PY}", file=sys.stderr)
        return 2

    rows: list[dict] = []
    for i in range(args.runs):
        row = one_run(i, args.keep)
        rows.append(row)
        print(
            f"run {i + 1}: spawn->tcp {fmt(row['t_tcp'])}  ->http {fmt(row['t_http'])}  "
            f"->cron-started {fmt(row['t_cron'])}  rss={row['rss_mb'] and round(row['rss_mb'], 1)}MB"
        )
        time.sleep(1.0)

    for key in ("t_tcp", "t_http", "t_cron"):
        vals = [r[key] for r in rows if r[key] is not None]
        if vals:
            print(f"{key}: median {statistics.median(vals):.2f}s  min {min(vals):.2f}s  max {max(vals):.2f}s")

    import shutil

    if not args.keep:
        shutil.rmtree(PROFILE_DIR, ignore_errors=True)
        print(f"(throwaway profile removed; keep it with --keep)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
