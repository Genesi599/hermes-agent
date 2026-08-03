"""Durable Conversation Branch validation and checkpoint forking.

This module deliberately owns no gateway globals.  RPC handlers and the
``conversation_branches`` model tool both call it through the gateway service,
so single and batch branches share the same persistence invariants.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterable


BRANCH_STATUSES = {
    "pending_checkpoint",
    "creating",
    "queued",
    "starting",
    "running",
    "paused",
    "interrupted",
    "completed",
    "failed",
    "cancelled",
}
WORKSPACE_MODES = {"shared", "shared_unique_outputs", "git_worktree"}
MAX_BRANCHES_PER_BATCH = 10


@dataclass(frozen=True)
class ForkResult:
    branch_session_id: str
    title: str
    parent_session_id: str
    message_count: int


def normalize_branch_specs(branches: Any) -> list[dict[str, Any]]:
    if not isinstance(branches, list) or not 1 <= len(branches) <= MAX_BRANCHES_PER_BATCH:
        raise ValueError("branches must contain between 1 and 10 tasks")

    normalized: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    claimed_outputs: set[str] = set()
    claimed_worktrees: set[str] = set()
    for index, raw in enumerate(branches):
        if not isinstance(raw, dict):
            raise ValueError(f"branches[{index}] must be an object")
        key = str(raw.get("client_branch_key") or "").strip()
        title = str(raw.get("title") or "").strip()
        prompt = str(raw.get("initial_prompt") or "").strip()
        if not key or not title or not prompt:
            raise ValueError(
                f"branches[{index}] requires client_branch_key, title, and initial_prompt"
            )
        if key in seen_keys:
            raise ValueError(f"duplicate client_branch_key: {key}")
        seen_keys.add(key)

        mode = str(raw.get("workspace_mode") or "shared").strip()
        if mode not in WORKSPACE_MODES:
            raise ValueError(f"unsupported workspace_mode: {mode}")
        output_dir = str(raw.get("output_dir") or "").strip() or None
        cwd = str(raw.get("cwd") or "").strip() or None
        if mode == "shared_unique_outputs":
            if not output_dir:
                raise ValueError(
                    f"branches[{index}].output_dir is required for shared_unique_outputs"
                )
            output_key = output_dir.casefold()
            if output_key in claimed_outputs:
                raise ValueError(f"duplicate output_dir: {output_dir}")
            claimed_outputs.add(output_key)
        if mode == "git_worktree":
            if not cwd:
                raise ValueError(
                    f"branches[{index}].cwd must point to a prepared Desktop worktree"
                )
            cwd_key = cwd.casefold()
            if cwd_key in claimed_worktrees:
                raise ValueError(f"duplicate git worktree cwd: {cwd}")
            claimed_worktrees.add(cwd_key)

        toolsets = raw.get("toolsets") or []
        if not isinstance(toolsets, list) or not all(isinstance(item, str) for item in toolsets):
            raise ValueError(f"branches[{index}].toolsets must be a string array")
        normalized.append(
            {
                "client_branch_key": key,
                "title": title,
                "initial_prompt": prompt,
                "auto_start": bool(raw.get("auto_start", True)),
                "cwd": cwd,
                "workspace_mode": mode,
                "output_dir": output_dir,
                "model": str(raw.get("model") or "").strip() or None,
                "provider": str(raw.get("provider") or "").strip() or None,
                "toolsets": list(toolsets),
            }
        )
    return normalized


def validate_parent_lineage(db, parent_session_id: str, *, max_depth: int) -> dict[str, Any]:
    parent = db.get_session(parent_session_id)
    if not parent:
        raise ValueError("parent session not found")
    seen = {parent_session_id}
    current = parent
    depth = 0
    while current.get("parent_session_id"):
        ancestor_id = str(current["parent_session_id"])
        if ancestor_id in seen:
            raise ValueError("parent session lineage contains a cycle")
        seen.add(ancestor_id)
        depth += 1
        if depth >= max_depth:
            raise ValueError(f"maximum Conversation Branch depth is {max_depth}")
        current = db.get_session(ancestor_id) or {}
    return parent


def fork_conversation_session(
    *,
    db,
    parent: dict[str, Any],
    checkpoint: Iterable[dict[str, Any]],
    branch_session_id: str,
    title: str,
    runtime_options: dict[str, Any],
) -> ForkResult:
    """Create one durable child from a stable, completed-turn checkpoint."""
    parent_id = str(parent["id"])
    history = [dict(message) for message in checkpoint]
    if not history:
        raise ValueError("nothing to branch - send a message first")

    model_config = parent.get("model_config") or {}
    if isinstance(model_config, str):
        try:
            model_config = json.loads(model_config)
        except json.JSONDecodeError:
            model_config = {}
    model_config = dict(model_config)
    model_config.update(
        {
            "_branched_from": parent_id,
            "_branch_seed_message_count": len(history),
            "_branch_batch_id": runtime_options.get("batch_id"),
            "_branch_client_key": runtime_options.get("client_branch_key"),
            "_branch_workspace_mode": runtime_options.get("workspace_mode", "shared"),
        }
    )
    if runtime_options.get("output_dir"):
        model_config["_branch_output_dir"] = runtime_options["output_dir"]
    if runtime_options.get("provider"):
        model_config["provider"] = runtime_options["provider"]
    if runtime_options.get("toolsets"):
        model_config["toolsets"] = list(runtime_options["toolsets"])

    source = str(parent.get("source") or "desktop")
    profile_name = str(parent.get("profile_name") or "")
    cwd = runtime_options.get("cwd") or parent.get("cwd")
    model = runtime_options.get("model") or parent.get("model")
    try:
        db.create_session(
            branch_session_id,
            source=source,
            model=model,
            model_config=model_config,
            system_prompt=parent.get("system_prompt"),
            parent_session_id=parent_id,
            cwd=cwd,
            profile_name=profile_name,
        )
        for message in history:
            db.append_message(
                session_id=branch_session_id,
                role=message.get("role", "user"),
                content=message.get("content"),
                tool_name=message.get("tool_name"),
                tool_calls=message.get("tool_calls"),
                tool_call_id=message.get("tool_call_id"),
                token_count=message.get("token_count"),
                finish_reason=message.get("finish_reason"),
                reasoning=message.get("reasoning"),
                reasoning_content=message.get("reasoning_content"),
                reasoning_details=message.get("reasoning_details"),
                codex_reasoning_items=message.get("codex_reasoning_items"),
                codex_message_items=message.get("codex_message_items"),
                platform_message_id=message.get("platform_message_id"),
                observed=bool(message.get("observed")),
                effect_disposition=message.get("effect_disposition"),
                timestamp=message.get("timestamp"),
                api_content=message.get("api_content"),
            )
        db.set_session_title(branch_session_id, title)
    except Exception:
        db.delete_session(branch_session_id)
        raise

    return ForkResult(
        branch_session_id=branch_session_id,
        title=title,
        parent_session_id=parent_id,
        message_count=len(history),
    )


def branch_batch_public_payload(batch: dict[str, Any]) -> dict[str, Any]:
    branches = batch.get("branches") or []
    return {
        "batch_id": batch.get("batch_id"),
        "parent_session_id": batch.get("parent_session_id"),
        "state": batch.get("state"),
        "max_parallel": batch.get("max_parallel"),
        "created_count": sum(bool(item.get("branch_session_id")) for item in branches),
        "started_count": sum(item.get("status") in {"running", "completed"} for item in branches),
        "queued_count": sum(item.get("status") in {"pending_checkpoint", "creating", "queued"} for item in branches),
        "branches": [
            {
                key: item.get(key)
                for key in (
                    "client_branch_key", "branch_session_id", "runtime_session_id",
                    "title", "status", "started_at", "completed_at", "error",
                    "artifact_manifest", "result_summary", "workspace_mode", "model", "provider",
                )
            }
            for item in branches
        ],
    }
