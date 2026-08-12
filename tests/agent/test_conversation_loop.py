"""conversation loop tests."""


class TestTaskStatusNudge:
    """_append_task_status_nudge appends a reminder to the live user turn."""

    def _import_fn(self):
        from agent.conversation_loop import _append_task_status_nudge
        return _append_task_status_nudge

    def test_appends_to_last_user_message(self):
        fn = self._import_fn()
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "你好，帮我分析数据"},
        ]
        fn(msgs, True)
        assert "[HERMES_TASK_STATUS]" in msgs[-1]["content"]
        assert "HERMES_TASK_STATUS" not in msgs[0]["content"]

    def test_disabled_is_noop(self):
        fn = self._import_fn()
        msgs = [{"role": "user", "content": "你好"}]
        fn(msgs, False)
        assert msgs[0]["content"] == "你好"

    def test_idempotent_when_already_nudged(self):
        fn = self._import_fn()
        msgs = [{"role": "user", "content": "你好\n\n[system note] End this reply with one line exactly like: [HERMES_TASK_STATUS]{..."}]
        before = msgs[0]["content"]
        fn(msgs, True)
        assert msgs[0]["content"] == before

    def test_multimodal_text_part(self):
        fn = self._import_fn()
        msgs = [{"role": "user", "content": [
            {"type": "text", "text": "看图"},
            {"type": "image", "image": "data:..."},
        ]}]
        fn(msgs, True)
        parts = msgs[0]["content"]
        assert "[HERMES_TASK_STATUS]" in parts[0]["text"]
        assert parts[-1]["type"] == "image"

    def test_no_user_message_is_noop(self):
        fn = self._import_fn()
        msgs = [{"role": "system", "content": "sys"}]
        fn(msgs, True)
        assert msgs == [{"role": "system", "content": "sys"}]
