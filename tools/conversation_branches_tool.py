#!/usr/bin/env python3
"""Desktop-only durable Conversation Branch orchestration tool."""

from __future__ import annotations

import json
import threading
from typing import Any, Callable, Optional

from tools.registry import registry


_callback_lock = threading.Lock()
_service_callback: Optional[Callable[[str, dict[str, Any], str], dict[str, Any]]] = None


def set_conversation_branches_callback(
    callback: Optional[Callable[[str, dict[str, Any], str], dict[str, Any]]]
) -> None:
    global _service_callback
    with _callback_lock:
        _service_callback = callback


def check_conversation_branches_requirements() -> bool:
    with _callback_lock:
        return _service_callback is not None


def _approval_summary(args: dict[str, Any]) -> str:
    branches = args.get("branches") or []
    titles = [str(item.get("title") or item.get("client_branch_key") or "branch") for item in branches]
    models = sorted({str(item.get("model") or "inherit") for item in branches})
    providers = sorted({str(item.get("provider") or "inherit") for item in branches})
    modes = sorted({str(item.get("workspace_mode") or "shared") for item in branches})
    return (
        f"Create and start {len(branches)} durable Conversation Branches: "
        f"{', '.join(titles)}. Models: {', '.join(models)}; providers: "
        f"{', '.join(providers)}; max parallel: {args.get('max_parallel') or 'configured default'}; "
        f"workspace modes: {', '.join(modes)}. These tasks may call models and write files."
    )


def conversation_branches(args: dict[str, Any], *, task_id: str = "") -> str:
    action = str(args.get("action") or "").strip()
    if action not in {"create_batch", "list", "status", "send", "pause", "resume", "cancel", "request_merge"}:
        return json.dumps({"success": False, "error": f"unsupported action: {action}"})

    with _callback_lock:
        callback = _service_callback
    if callback is None:
        return json.dumps({"success": False, "error": "Conversation Branch service is unavailable"})

    if action == "create_batch" and any(
        bool(item.get("auto_start", True)) for item in (args.get("branches") or []) if isinstance(item, dict)
    ):
        from tools.approval import request_tool_approval

        approval = request_tool_approval(
            "conversation_branches",
            _approval_summary(args),
            rule_key=f"conversation_branches:create_batch:{args.get('request_id') or ''}",
        )
        if not approval.get("approved"):
            return json.dumps({"success": False, "error": approval.get("message") or "approval denied"})

    if action == "request_merge":
        from tools.approval import request_tool_approval

        approval = request_tool_approval(
            "conversation_branches",
            "Review and merge the selected Conversation Branch into its parent Session.",
            rule_key=f"conversation_branches:request_merge:{args.get('branch_session_id') or ''}",
        )
        if not approval.get("approved"):
            return json.dumps({"success": False, "error": approval.get("message") or "approval denied"})

    try:
        result = callback(action, dict(args), task_id)
        return json.dumps({"success": True, **result}, ensure_ascii=False)
    except (ValueError, PermissionError) as exc:
        return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)


CONVERSATION_BRANCHES_SCHEMA = {
    "name": "conversation_branches",
    "description": (
        "Create and manage durable Conversation Branch Sessions visible in Hermes Desktop. "
        "Use create_batch for parallel work that must remain independently openable and resumable. "
        "This is not Git branching and does not return transcripts."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["create_batch", "list", "status", "send", "pause", "resume", "cancel", "request_merge"],
            },
            "parent_session_id": {"type": "string"},
            "branch_session_id": {"type": "string"},
            "batch_id": {"type": "string"},
            "request_id": {"type": "string"},
            "branch_point_message_id": {"type": "integer"},
            "max_parallel": {"type": "integer", "minimum": 1, "maximum": 10},
            "message": {"type": "string"},
            "branches": {
                "type": "array",
                "minItems": 1,
                "maxItems": 10,
                "items": {
                    "type": "object",
                    "properties": {
                        "client_branch_key": {"type": "string"},
                        "title": {"type": "string"},
                        "initial_prompt": {"type": "string"},
                        "auto_start": {"type": "boolean", "default": True},
                        "cwd": {"type": "string"},
                        "workspace_mode": {"type": "string", "enum": ["shared", "shared_unique_outputs", "git_worktree"]},
                        "output_dir": {"type": "string"},
                        "model": {"type": "string"},
                        "provider": {"type": "string"},
                        "toolsets": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["client_branch_key", "title", "initial_prompt"],
                },
            },
        },
        "required": ["action"],
    },
}


registry.register(
    name="conversation_branches",
    toolset="conversation_branches",
    schema=CONVERSATION_BRANCHES_SCHEMA,
    handler=lambda args, **kw: conversation_branches(args, task_id=kw.get("task_id") or ""),
    check_fn=check_conversation_branches_requirements,
    emoji="⑂",
)
