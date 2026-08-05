"""Custom visible review handlers for destructive session operations."""

from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()
method = _registry.method


@method("session.review_delete")
def _(rid, params: dict) -> dict:
    target = str(params.get("session_id") or "").strip()
    runtime_sid = str(params.get("runtime_session_id") or "").strip()
    if not target:
        return _err(rid, 4006, "session_id required")
    if not runtime_sid:
        return _err(
            rid,
            4040,
            "runtime session not found; resume the session before deleting",
        )

    db = _get_db()
    if db is None:
        return _db_unavailable_error(rid, code=5036)
    stored = db.get_session(target)
    if stored is None:
        return _err(rid, 4007, "session not found")

    with _sessions_lock:
        live_session = _sessions.get(runtime_sid)
    live_key = str((live_session or {}).get("session_key") or "").strip()
    expected_live_key = target
    if live_key and live_key != target:
        try:
            expected_live_key = str(db.resolve_resume_session_id(target) or target)
        except Exception:
            expected_live_key = target
    if live_session is None or live_key != expected_live_key:
        return _err(
            rid,
            4040,
            "runtime session does not match the stored session; resume it before deleting",
        )

    with live_session["history_lock"]:
        if live_session.get("_delete_review_pending"):
            return _err(rid, 4042, "delete review is already running")
        live_session["_delete_review_pending"] = True
        queued_before = live_session.pop("queued_prompt", None)

    def restore_after_failure() -> None:
        with live_session["history_lock"]:
            live_session["_delete_review_pending"] = False
            if queued_before is not None and not live_session.get("queued_prompt"):
                live_session["queued_prompt"] = queued_before
        if queued_before is not None:
            _schedule_queued_prompt_retry(rid, runtime_sid, live_session)

    if live_session.get("running"):
        agent = live_session.get("agent")
        if agent is not None and hasattr(agent, "interrupt"):
            try:
                agent.interrupt()
            except Exception:
                pass
        deadline = time.time() + 30.0
        while live_session.get("running") and time.time() < deadline:
            time.sleep(0.1)
        if live_session.get("running"):
            restore_after_failure()
            return _err(rid, 4035, "session did not stop in time; delete review was not started")

    if (transport := current_transport()) is not None:
        live_session["transport"] = transport
    if live_session.get("agent") is None:
        _start_agent_build(runtime_sid, live_session)
        if build_error := _wait_agent(live_session, rid):
            restore_after_failure()
            message = build_error.get("error", {}).get("message", "agent initialization failed")
            return _err(rid, 5037, f"delete review failed: {message}")

    review_done = threading.Event()
    review_result = {"status": "error", "text": "delete review did not complete"}

    def review_complete(status: str, text: str) -> None:
        review_result["status"] = status
        review_result["text"] = text
        review_done.set()

    with live_session["history_lock"]:
        if live_session.get("running"):
            restore_after_failure()
            return _err(rid, 4035, "session became busy before delete review")
        live_session["running"] = True
        live_session["last_active"] = time.time()

    title = str(stored.get("title") or target).strip()
    _emit(
        "delete_review.status",
        runtime_sid,
        {"phase": "reviewing", "text": "开始删除前复盘；复盘成功后将自动删除此对话。"},
    )
    try:
        _run_prompt_submit(
            rid,
            runtime_sid,
            live_session,
            _delete_review_prompt(title),
            internal_kind="delete_review",
            completion_callback=review_complete,
        )
    except Exception as exc:
        with live_session["history_lock"]:
            live_session["running"] = False
        restore_after_failure()
        return _err(rid, 5037, f"delete review failed: {exc}")

    if not review_done.wait(1800):
        agent = live_session.get("agent")
        if agent is not None and hasattr(agent, "interrupt"):
            try:
                agent.interrupt()
            except Exception:
                pass
        restore_after_failure()
        return _err(rid, 5040, "delete review timed out; session was preserved")

    summary = str(review_result["text"]).strip()
    if review_result["status"] != "complete" or not summary:
        restore_after_failure()
        return _err(rid, 5037, f"delete review failed: {summary or review_result['status']}")

    _emit(
        "delete_review.status",
        runtime_sid,
        {"phase": "complete", "text": "删除前复盘已完成，正在删除对话。"},
    )
    with live_session["history_lock"]:
        live_session["_delete_review_pending"] = False
    delete_ids = list(
        dict.fromkeys(filter(None, [str(live_session.get("session_key") or "").strip(), target]))
    )
    _close_session_by_id(runtime_sid, end_reason="reviewed_deleted")
    try:
        deleted_count = db.delete_sessions(
            delete_ids, sessions_dir=get_hermes_home() / "sessions"
        )
    except Exception as exc:
        return _err(rid, 5036, f"review completed but delete failed: {exc}")
    if not deleted_count:
        return _err(rid, 4007, "review completed but session was already absent")
    return _ok(rid, {"deleted": target, "deleted_ids": delete_ids, "summary": summary})


@method("session.merge_branch")
def _(rid, params: dict) -> dict:
    target = str(params.get("session_id") or "").strip()
    if not target:
        return _err(rid, 4006, "session_id required")
    db = _get_db()
    if db is None:
        return _db_unavailable_error(rid, code=5036)

    child = db.get_session(target)
    if child is None:
        return _err(rid, 4007, "session not found")
    parent_id = str(child.get("parent_session_id") or "").strip()
    if not parent_id:
        return _err(rid, 4033, "session is not a branch")
    if db.get_session(parent_id) is None:
        return _err(rid, 4034, "parent session not found")

    with _sessions_lock:
        live = list(_sessions.items())
    related = [
        (sid, session)
        for sid, session in live
        if session.get("session_key") in {target, parent_id}
    ]
    if any(
        session.get("running")
        for _, session in related
        if session.get("session_key") == target
    ):
        return _err(rid, 4035, "stop the branch before merging")

    marker = f"branch-merge:{target}"
    parent_messages = db.get_messages(parent_id)
    already_injected = next(
        (message for message in parent_messages if message.get("platform_message_id") == marker),
        None,
    )
    pending_getter = getattr(db, "get_pending_branch_merge", None)
    pending_merge = pending_getter(target) if callable(pending_getter) else None
    queued_content = str((pending_merge or {}).get("branch_merge_summary") or "").strip()
    seed_count = 0

    if already_injected is None and not queued_content:
        child_messages = db.get_messages(target)
        seed_count = _branch_seed_count(child, child_messages, parent_messages)
        merge_input = _branch_merge_input(child_messages[seed_count:])
        if not merge_input:
            return _err(rid, 4036, "branch has no new messages to merge")

        runtime_sid = str(params.get("runtime_session_id") or "").strip()
        visible_runtime = next(
            (
                (live_sid, live_session)
                for live_sid, live_session in related
                if (not runtime_sid or live_sid == runtime_sid)
                and live_session.get("session_key") == target
            ),
            None,
        )
        if visible_runtime is None:
            return _err(
                rid,
                4040,
                "branch runtime session not found; resume the branch before merging",
            )

        live_sid, live_session = visible_runtime
        review_done = threading.Event()
        review_result = {"status": "error", "text": "branch review did not complete"}

        def review_complete(status: str, text: str) -> None:
            review_result["status"] = status
            review_result["text"] = text
            review_done.set()

        if (transport := current_transport()) is not None:
            live_session["transport"] = transport
        if live_session.get("agent") is None:
            _start_agent_build(live_sid, live_session)
            if build_error := _wait_agent(live_session, rid):
                message = build_error.get("error", {}).get("message", "agent initialization failed")
                return _err(rid, 5037, f"branch review failed: {message}")
        with live_session["history_lock"]:
            if live_session.get("running"):
                return _err(rid, 4035, "stop the branch before merging")
            live_session["running"] = True
            live_session["last_active"] = time.time()

        title = str(child.get("title") or target).strip()
        _emit(
            "branch_merge.status",
            live_sid,
            {"phase": "reviewing", "text": "开始合并前复盘；复盘成功后将自动注入父对话并删除此子对话。"},
        )
        try:
            _run_prompt_submit(
                rid,
                live_sid,
                live_session,
                _branch_merge_review_prompt(title, merge_input),
                internal_kind="branch_merge_review",
                completion_callback=review_complete,
            )
        except Exception as exc:
            with live_session["history_lock"]:
                live_session["running"] = False
            return _err(rid, 5037, f"branch review failed: {exc}")

        if not review_done.wait(1800):
            agent = live_session.get("agent")
            if agent is not None and hasattr(agent, "interrupt"):
                try:
                    agent.interrupt()
                except Exception:
                    pass
            return _err(rid, 5040, "branch review timed out; branch was preserved")

        summary = str(review_result["text"]).strip()
        if review_result["status"] != "complete" or not summary:
            return _err(rid, 5037, f"branch review failed: {summary or review_result['status']}")
        queued_content = f"[Branch merge summary: {title}]\n\n{summary}"
        queuer = getattr(db, "queue_branch_merge", None)
        if not callable(queuer) or not queuer(target, queued_content):
            return _err(rid, 5038, "could not queue branch summary")
    elif already_injected is not None:
        queued_content = _merge_message_text(already_injected.get("content"))

    deleted_ids = _apply_pending_branch_merges(parent_id)
    deleted = target in deleted_ids
    if not deleted and db.get_session(target) is None:
        deleted_ids.append(target)
        deleted = True
    if not deleted:
        child_runtime = next(
            (sid for sid, session in related if session.get("session_key") == target),
            "",
        )
        if child_runtime:
            _emit(
                "branch_merge.status",
                child_runtime,
                {
                    "phase": "queued",
                    "text": "复盘已完成；父对话正在运行，已排队等待本轮结束后注入。",
                    "parent_session_id": parent_id,
                },
            )
    return _ok(
        rid,
        {
            "deleted": target if deleted else None,
            "deleted_ids": deleted_ids,
            "queued": not deleted,
            "parent_session_id": parent_id,
            "seed_message_count": seed_count,
            "summary": queued_content,
        },
    )


def register(server) -> None:
    _registry.install(server)
