"""Continuous retries for temporary provider/network failures."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from agent.conversation_loop import _extend_transient_retry_budget
from agent.error_classifier import ClassifiedError, FailoverReason
from run_agent import AIAgent


def _mock_response(content: str):
    message = SimpleNamespace(content=content, tool_calls=None)
    choice = SimpleNamespace(message=message, finish_reason="stop")
    return SimpleNamespace(choices=[choice], model="test/model", usage=None)


def _make_agent():
    with (
        patch("run_agent.get_tool_definitions", return_value=[]),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI", return_value=MagicMock()),
    ):
        agent = AIAgent(
            api_key="test-key",
            base_url="https://example.invalid/v1",
            provider="custom",
            model="test/model",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
        agent.client = MagicMock()
        return agent


@pytest.mark.parametrize(
    "reason",
    [
        FailoverReason.timeout,
        FailoverReason.overloaded,
        FailoverReason.server_error,
        FailoverReason.rate_limit,
        FailoverReason.upstream_rate_limit,
    ],
)
def test_extends_exhausted_budget_for_known_transient_failures(reason):
    agent = SimpleNamespace(_retry_transient_forever=True, _api_max_retries=3)
    classified = ClassifiedError(reason=reason, retryable=True)

    assert _extend_transient_retry_budget(
        agent, classified, retry_count=3, max_retries=3
    ) == 6


@pytest.mark.parametrize(
    "reason",
    [
        FailoverReason.auth,
        FailoverReason.billing,
        FailoverReason.format_error,
        FailoverReason.context_overflow,
        FailoverReason.unknown,
    ],
)
def test_does_not_extend_budget_for_deterministic_or_unknown_failures(reason):
    agent = SimpleNamespace(_retry_transient_forever=True, _api_max_retries=3)
    classified = ClassifiedError(reason=reason, retryable=True)

    assert _extend_transient_retry_budget(
        agent, classified, retry_count=3, max_retries=3
    ) == 3


def test_does_not_extend_before_exhaustion_or_when_disabled():
    classified = ClassifiedError(reason=FailoverReason.timeout, retryable=True)

    enabled = SimpleNamespace(_retry_transient_forever=True, _api_max_retries=3)
    assert _extend_transient_retry_budget(
        enabled, classified, retry_count=2, max_retries=3
    ) == 3

    disabled = SimpleNamespace(_retry_transient_forever=False, _api_max_retries=3)
    assert _extend_transient_retry_budget(
        disabled, classified, retry_count=3, max_retries=3
    ) == 3


def test_full_turn_recovers_after_multiple_exhausted_retry_batches():
    agent = _make_agent()
    agent._api_max_retries = 2
    agent._retry_transient_forever = True
    calls = 0

    def flaky_api_call(_api_kwargs):
        nonlocal calls
        calls += 1
        if calls <= 5:
            raise TimeoutError("Codex stream produced no bytes within 120s")
        return _mock_response("Recovered")

    with (
        patch.object(agent, "_interruptible_api_call", side_effect=flaky_api_call),
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
        patch.object(agent, "_emit_status") as emit_status,
        patch("run_agent.OpenAI", return_value=MagicMock()),
        patch("agent.agent_runtime_helpers.time.sleep"),
        patch("agent.model_metadata.get_model_context_length", return_value=200000),
    ):
        result = agent.run_conversation("hello")

    assert calls == 6
    assert result["completed"] is True
    assert result["final_response"] == "Recovered"
    assert any(
        "after 4 attempts" in call.args[0]
        and "Continuing automatic retries" in call.args[0]
        for call in emit_status.call_args_list
    )
