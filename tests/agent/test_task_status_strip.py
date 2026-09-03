"""custom/hermes-yh: task-status block stripping when guidance is disabled.

Covers strip_task_status_blocks / _strip_task_status_from_history used on the
send path (kill the in-history imitation source) and in finalize_turn (never
persist an imitated block). See agent/conversation_loop.py.
"""

from agent.conversation_loop import (
    _strip_task_status_from_history,
    strip_task_status_blocks,
)


def test_strip_removes_trailing_block_and_whitespace():
    text = (
        "Here is the answer.\n\n"
        '[HERMES_TASK_STATUS]{"background":"x","progress":"y","next":"z",'
        '"skip":false}[/HERMES_TASK_STATUS]\n'
    )
    assert strip_task_status_blocks(text) == "Here is the answer."


def test_strip_removes_mid_text_block_and_keeps_rest():
    text = (
        "before [HERMES_TASK_STATUS]{\"a\":1}[/HERMES_TASK_STATUS] middle "
        "[HERMES_TASK_STATUS]{\"b\":2}[/HERMES_TASK_STATUS] after"
    )
    assert strip_task_status_blocks(text) == "before middle after"


def test_strip_noop_without_marker_and_with_unterminated_block():
    assert strip_task_status_blocks("plain text") == "plain text"
    # Unterminated block: regex needs the closing tag, so it stays — safe
    # (persisted as-is, Desktop still strips at render).
    assert strip_task_status_blocks("x [HERMES_TASK_STATUS]{oops") == "x [HERMES_TASK_STATUS]{oops"


def test_history_strip_touches_only_assistant_messages():
    msgs = [
        {"role": "user", "content": "q [HERMES_TASK_STATUS]{\"k\":1}[/HERMES_TASK_STATUS]"},
        {"role": "assistant", "content": "a1 [HERMES_TASK_STATUS]{\"k\":1}[/HERMES_TASK_STATUS]"},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "a2 [HERMES_TASK_STATUS]{\"k\":2}[/HERMES_TASK_STATUS]"},
                {"type": "image_url", "image_url": {"url": "data:x"}},
            ],
        },
        {"role": "tool", "content": "[HERMES_TASK_STATUS]{\"k\":3}[/HERMES_TASK_STATUS]"},
    ]
    _strip_task_status_from_history(msgs)
    assert msgs[0]["content"].startswith("q [HERMES_TASK_STATUS]")  # user untouched
    assert msgs[1]["content"] == "a1"
    assert msgs[2]["content"][0]["text"] == "a2"
    assert msgs[2]["content"][1]["type"] == "image_url"
    assert msgs[3]["content"].startswith("[HERMES_TASK_STATUS]")  # tool untouched
