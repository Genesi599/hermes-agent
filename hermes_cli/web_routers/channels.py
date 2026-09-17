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

import os
import subprocess
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
