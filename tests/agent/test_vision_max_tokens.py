"""auxiliary.vision.max_tokens must be configurable (was hardcoded 2000).

Reasoning vision models (glm-5.3-flash, deepseek-v4.1) spend most of the token
budget on reasoning tokens, so a 2000 cap truncates the actual description
(``finish_reason=length`` with a short body). The caller may now raise it via
``auxiliary.vision.max_tokens``; the default stays 2000 so existing setups are
unchanged. Mirrors how ``auxiliary.vision.timeout`` / ``temperature`` are read
in ``tools/vision_tools.py:_handle_vision_analyze``.
"""

from __future__ import annotations

import asyncio
import base64
from types import SimpleNamespace
from unittest.mock import patch

import tools.vision_tools as vt

_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=="
)


def _fake_response(text: str):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=text, reasoning_content="")
            )
        ]
    )


def _run(tmp_path, cfg):
    img = tmp_path / "img.png"
    img.write_bytes(_PNG)
    captured = {}

    async def fake_call_llm(**kwargs):
        captured.update(kwargs)
        return _fake_response("a description")

    with patch.object(vt, "_should_use_native_vision_fast_path", return_value=False), \
         patch.object(vt, "async_call_llm", side_effect=fake_call_llm), \
         patch.object(vt, "_load_auxiliary_client", lambda: None), \
         patch.object(vt, "extract_content_or_reasoning",
                      lambda resp: resp.choices[0].message.content), \
         patch.object(vt, "_debug", SimpleNamespace(log_call=lambda *a, **k: None, save=lambda: None)), \
         patch("hermes_cli.config.load_config", return_value=cfg):
        out = asyncio.run(
            vt._handle_vision_analyze({"image_url": str(img), "question": "what is this?"})
        )
    return captured, out


def test_max_tokens_defaults_to_2000(tmp_path):
    captured, out = _run(tmp_path, {})
    assert captured["max_tokens"] == 2000
    assert captured["task"] == "vision"
    assert "a description" in out


def test_max_tokens_read_from_config(tmp_path):
    captured, _ = _run(tmp_path, {"auxiliary": {"vision": {"max_tokens": 6000}}})
    assert captured["max_tokens"] == 6000


def test_invalid_max_tokens_falls_back_to_default(tmp_path):
    captured, _ = _run(tmp_path, {"auxiliary": {"vision": {"max_tokens": "not-a-number"}}})
    assert captured["max_tokens"] == 2000
