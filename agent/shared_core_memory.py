"""Load yh109's portable AI-Agent-Hub core memory at compression boundaries."""

from __future__ import annotations

from pathlib import Path

CORE_MEMORY_FILES = (
    "MEMORY.md",
    "user_profile.md",
    "workspace.md",
    "preferences.md",
    "environment.md",
    "knowledge_base.md",
)
SHARED_CORE_MEMORY_HEADER = "AI-AGENT-HUB SHARED CORE MEMORY"
MAX_CORE_MEMORY_CHARS = 200_000


def shared_core_memory_root(home: Path | None = None) -> Path:
    return (home or Path.home()) / "Documents" / "GitHub" / "AI-Agent-Hub" / "memory"


def load_shared_core_memory_prompt(
    *,
    home: Path | None = None,
    max_chars: int = MAX_CORE_MEMORY_CHARS,
) -> str:
    """Read the six trusted core files in a stable order for prompt injection."""
    root = shared_core_memory_root(home)
    remaining = max(0, int(max_chars))
    sections: list[str] = []

    for name in CORE_MEMORY_FILES:
        if remaining <= 0:
            break

        path = root / name
        try:
            content = path.read_text(encoding="utf-8-sig").strip()
        except (OSError, UnicodeError):
            continue

        if not content:
            continue

        if len(content) > remaining:
            content = content[:remaining].rstrip() + "\n\n[truncated by shared core memory limit]"
        sections.append(f"## {name}\n\n{content}")
        remaining -= min(len(content), remaining)

    if not sections:
        return ""

    return (
        f"{SHARED_CORE_MEMORY_HEADER}\n"
        "Reloaded from the current user's AI-Agent-Hub memory bank after context compression. "
        "Treat these files as authoritative shared context; do not edit them unless the user asks.\n\n"
        + "\n\n".join(sections)
    )
