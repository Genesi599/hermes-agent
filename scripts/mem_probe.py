"""Memory probe for Hermes backend import tree (Phase 0 baseline tool).

Measures staged RSS growth while importing the Hermes CLI/web stack with the
project venv interpreter, so per-profile `hermes serve` idle memory can be
attributed to module clusters before any lazy-import work.

Usage (from the repo root, with the backend venv):

    venv/Scripts/python.exe -X utf8 scripts/mem_probe.py [--full]

`--full` also imports the heavy third-party stack explicitly (pydantic,
fastapi, uvicorn, httpx, aiohttp, websockets, PIL, numpy) to approximate the
runtime footprint of a fully-booted backend process. Without it, the probe
reports only what Hermes' own module tree pulls in on its own.
"""

from __future__ import annotations

import argparse
import gc
import sys
from collections import Counter

M = 1024 * 1024.0

try:
    import psutil
except ImportError:  # pragma: no cover
    print("psutil is required (present in the backend venv)", file=sys.stderr)
    raise SystemExit(2)

PROC = psutil.Process()


def report(tag: str) -> None:
    info = PROC.memory_info()
    print(
        f"{tag:44s} rss={info.rss / M:7.1f}MB  "
        f"private_hint={getattr(info, 'private', 0) / M:7.1f}MB  "
        f"modules={len(sys.modules)}"
    )


HEAVY_THIRD_PARTY = [
    "pydantic",
    "fastapi",
    "uvicorn",
    "httpx",
    "aiohttp",
    "websockets",
    "PIL",
    "numpy",
]

HERMES_STAGES = [
    "hermes_cli.main",
    "hermes_cli.web_server",
    "agent",
    "gateway",
    "tui_gateway",
    "providers",
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full", action="store_true", help="import heavy third-party stack too")
    args = parser.parse_args()

    report("interpreter + psutil (baseline)")

    if args.full:
        for mod in HEAVY_THIRD_PARTY:
            __import__(mod)
            report(f"import {mod}")

    for mod in HERMES_STAGES:
        __import__(mod)
        report(f"import {mod}")

    gc.collect()
    report("final")

    print("--- top object classes (count) ---")
    counts = Counter(f"{type(o).__module__}.{type(o).__name__}" for o in gc.get_objects())
    for name, count in counts.most_common(10):
        print(f"{count:9d}  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
