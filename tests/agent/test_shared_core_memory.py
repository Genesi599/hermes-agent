from agent.shared_core_memory import (
    CORE_MEMORY_FILES,
    SHARED_CORE_MEMORY_HEADER,
    load_shared_core_memory_prompt,
)


def test_loads_all_core_files_in_stable_order(tmp_path):
    root = tmp_path / "Documents" / "GitHub" / "AI-Agent-Hub" / "memory"
    root.mkdir(parents=True)
    for index, name in enumerate(CORE_MEMORY_FILES):
        (root / name).write_text(f"content-{index}", encoding="utf-8")

    prompt = load_shared_core_memory_prompt(home=tmp_path)

    assert prompt.startswith(SHARED_CORE_MEMORY_HEADER)
    offsets = [prompt.index(f"## {name}") for name in CORE_MEMORY_FILES]
    assert offsets == sorted(offsets)
    for index in range(len(CORE_MEMORY_FILES)):
        assert f"content-{index}" in prompt


def test_reloads_changed_content_and_skips_missing_files(tmp_path):
    root = tmp_path / "Documents" / "GitHub" / "AI-Agent-Hub" / "memory"
    root.mkdir(parents=True)
    memory = root / "MEMORY.md"
    memory.write_text("before", encoding="utf-8")
    assert "before" in load_shared_core_memory_prompt(home=tmp_path)

    memory.write_text("after", encoding="utf-8")
    prompt = load_shared_core_memory_prompt(home=tmp_path)

    assert "after" in prompt
    assert "before" not in prompt


def test_applies_total_character_limit(tmp_path):
    root = tmp_path / "Documents" / "GitHub" / "AI-Agent-Hub" / "memory"
    root.mkdir(parents=True)
    (root / "MEMORY.md").write_text("x" * 100, encoding="utf-8")

    prompt = load_shared_core_memory_prompt(home=tmp_path, max_chars=12)

    assert "x" * 12 in prompt
    assert "truncated by shared core memory limit" in prompt
