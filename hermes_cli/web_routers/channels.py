"""Channel routes — the group chat as a FIRST-CLASS ENTITY.

A channel is where agents and the human exchange information. It owns its own
messages and is NOT a session (no `sessions` row), so posting a line is an
INSERT, not a model turn — that is the point of the entity: the room is a place,
not somebody's conversation. Agents post through the delivery path
(`scripts/agent_outbox_*.py` → the channel store), never through a turn here.

The store lives on SessionDB (`get_or_create_channel`, `get_channel`,
`append_channel_message`, `get_channel_messages`, `pending_channel_messages`,
`mark_channel_message_routed`); these handlers only shape HTTP around it.
"""

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel

from hermes_cli.web_deps import late

router = APIRouter()

_open_session_db_for_profile = late("_open_session_db_for_profile")


class ChannelCreate(BaseModel):
    project: str
    title: Optional[str] = None


class ChannelMessagePost(BaseModel):
    """A HUMAN line. Agents post through the delivery path, not this endpoint."""

    content: str
    author_label: Optional[str] = None


def _open(profile: Optional[str], *, read_only: bool):
    return _open_session_db_for_profile(profile, read_only=read_only)


def _trigger_router(message_id: int) -> None:
    """Hand one new human line to the routing watchdog, off the request path.

    Who a message concerns is HERMES's judgement (that is the model), so routing
    runs as its own process — this endpoint only records the line and nudges the
    watchdog, keeping "posting" a pure insert.
    """
    home = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes"
    script = home / "scripts" / "channel_router.py"
    python = home / "hermes-agent" / "venv" / "Scripts" / "python.exe"

    if not script.exists() or not python.exists():
        return

    try:
        subprocess.Popen(
            [str(python), str(script), f"--message={message_id}"],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError:
        pass  # the */2 watchdog will pick the line up anyway


@router.get("/api/channels")
def list_channels(
    project: Optional[str] = Query(None),
    profile: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Channels, newest activity first; `project` narrows to one project's room."""
    db = _open(profile, read_only=True)

    try:
        return {"channels": db.list_channels(project) if project else db.list_channels()}
    finally:
        db.close()


@router.post("/api/channels")
def create_channel(body: ChannelCreate, profile: Optional[str] = Query(None)) -> Dict[str, Any]:
    """Get-or-create the room for a project (idempotent by project name)."""
    db = _open(profile, read_only=False)

    try:
        channel_id = db.get_or_create_channel(body.project, body.title or "")

        return {"id": channel_id, "channel": db.get_channel(channel_id)}
    finally:
        db.close()


class ChannelEnsureFromSession(BaseModel):
    """Promote a session to its project's room (idempotent; history imported)."""

    session_id: str


# The maintainer's own per-project talk: `<project> · Hermes` (with the
# dedupe counter the session namer appends). Mirrors
# apps/desktop/src/lib/session-agents.ts isHermesConversation.
_HERMES_OWN_TITLE_RE = re.compile(r" · Hermes( \(\d+\))?$")


def _cron_bound_session_ids() -> set:
    """Sessions a cron still runs its turns IN (attach_to_session targets).

    A content cron (复盘/巡查) reports into its session's transcript; a room
    cannot show that, so those sessions stay conversations. Plumbing crons
    (投递/频道路由) deliver channel-first and are exempt via the bound-channel
    check that runs before this one.
    """
    home = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes"

    try:
        data = json.loads((home / "cron" / "jobs.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()

    jobs = data if isinstance(data, list) else data.get("jobs", [])
    targets = set()

    for job in jobs:
        if isinstance(job, dict) and job.get("attach_to_session"):
            target = job.get("target_session_id")
            if target:
                targets.add(str(target))

    return targets


@router.post("/api/channels/ensure-from-session")
def ensure_channel_from_session(
    body: ChannelEnsureFromSession,
    profile: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """The channel for a session — bound (and the transcript imported) on first call.

    Every conversation is its project's room, so this is how a session BECOMES
    a group chat: the first call binds channel↔session by id (renames cannot
    break it), imports what was said there, and from then on the desktop
    surface for that session is the channel. Sessions that must stay
    conversations return `channel: null` with a reason: platform threads
    (weixin/feishu), the maintainer's own `· Hermes` talks, untitled
    newborns, and sessions a content cron still reports into.
    """
    session_id = (body.session_id or "").strip()

    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")

    db = _open(profile, read_only=False)

    try:
        session = db.get_session(session_id) or {}

        # A session with a bound channel IS its project's room, whatever its
        # origin (the first room started life as a weixin thread): the binding
        # outranks every keep-it-a-conversation rule below.
        bound = db.get_channel_for_session(session_id)
        if bound:
            title = (session.get("title") or "").strip()
            if (
                title
                and bound.get("project") != title
                and time.time() - float(bound.get("created_at") or 0) < 900
                and db.get_channel_for_project(title) is None
            ):
                # The room was born during the naming window (auto-title can
                # land after the transient first-message echo); carry the real
                # name before the board directory or agent naming anchor to
                # the placeholder. Older rooms keep a frozen project name.
                db.rename_channel(bound["id"], title)
                bound = db.get_channel(bound["id"])

            return {"channel": bound, "created": False}

        if not (session.get("title") or "").strip():
            return {"channel": None, "reason": "untitled"}
        if str(session.get("source") or "").lower() in {"weixin", "feishu"}:
            return {"channel": None, "reason": "platform_session"}
        if _HERMES_OWN_TITLE_RE.search((session.get("title") or "").strip()):
            return {"channel": None, "reason": "agent_conversation"}

        if session_id in _cron_bound_session_ids():
            return {"channel": None, "reason": "cron_reports_here"}

        title = session["title"].strip()
        channel_id = db.get_or_create_channel(title, title, session_id=session_id)
        counts = db.import_session_into_channel(channel_id, session_id)

        return {"channel": db.get_channel(channel_id), "created": True, **counts}
    finally:
        db.close()


@router.get("/api/channels/{channel_id}/messages")
def channel_messages(
    channel_id: str,
    limit: int = Query(200, ge=1, le=1000),
    before: Optional[int] = Query(None),
    profile: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """The room's lines, oldest→newest; `before` pages backwards."""
    db = _open(profile, read_only=True)

    try:
        if db.get_channel(channel_id) is None:
            raise HTTPException(status_code=404, detail=f"unknown channel: {channel_id}")

        messages: List[Dict[str, Any]] = db.get_channel_messages(channel_id, limit=limit, before=before)

        return {"channel_id": channel_id, "messages": messages}
    finally:
        db.close()


@router.post("/api/channels/{channel_id}/messages")
def post_channel_message(
    channel_id: str,
    body: ChannelMessagePost,
    background: BackgroundTasks,
    profile: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Post a HUMAN line into the room.

    Recorded, not answered: no turn runs, so the room stays a place rather than
    becoming somebody's conversation. The line lands with `routed_at IS NULL`,
    which is what the routing watchdog picks up — Hermes decides who it concerns
    and wakes them; their replies arrive through the delivery path.
    """
    content = (body.content or "").strip()

    if not content:
        raise HTTPException(status_code=400, detail="empty message")

    db = _open(profile, read_only=False)

    try:
        if db.get_channel(channel_id) is None:
            raise HTTPException(status_code=404, detail=f"unknown channel: {channel_id}")

        message_id = db.append_channel_message(
            channel_id,
            content,
            author_kind="human",
            author_label=body.author_label or "杨航",
            role="user",
            display_kind=None,
        )

        background.add_task(_trigger_router, message_id)

        return {"channel_id": channel_id, "message_id": message_id, "routing": "triggered"}
    finally:
        db.close()


@router.get("/api/channels/pending")
def pending_channel_messages(
    limit: int = Query(20, ge=1, le=200),
    profile: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Human lines nobody has routed yet — the watchdog's work list."""
    db = _open(profile, read_only=True)

    try:
        return {"messages": db.pending_channel_messages(limit)}
    finally:
        db.close()


@router.post("/api/channels/messages/{message_id}/routed")
def mark_routed(message_id: int, profile: Optional[str] = Query(None)) -> Dict[str, Any]:
    """Book-keeping: this human line has been routed (who it concerns was decided)."""
    db = _open(profile, read_only=False)

    try:
        db.mark_channel_message_routed(message_id)

        return {"message_id": message_id, "routed": True}
    finally:
        db.close()
