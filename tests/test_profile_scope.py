"""阶段 1：profile_scope 的地基验证（见 docs/design/shared-backend-pool.md）。

断言三件事：
1. 无 scope 时 get_hermes_home() 等于进程自身（零回归）；
2. scope 内 get_hermes_home() 指向目标 profile 的家；
3. 退出后恢复（含异常路径与嵌套）。
"""

import os
import tempfile
from pathlib import Path

import pytest

from hermes_constants import get_hermes_home, get_process_hermes_home
from tui_gateway.profile_scope import (
    bare_session_id,
    profile_home_for,
    profile_home_scope,
    profile_of_session_key,
    profile_scope,
    session_key_for,
)


def test_home_scope_same_home_is_noop():
    """与进程自身 home 相同 → 不设 override（零回归，逐字节不变）。"""
    own = str(get_process_hermes_home())
    before = get_hermes_home()
    with profile_home_scope(own):
        assert get_hermes_home() == before
    with profile_home_scope(""):
        assert get_hermes_home() == before
    with profile_home_scope(None):
        assert get_hermes_home() == before


def test_home_scope_other_home_sets_and_restores():
    """其他 home → 作用域内指向它，退出恢复。"""
    own = str(get_process_hermes_home())
    other = str(profile_home_for("plotter"))
    if other == own:
        return  # 进程自身就是该 profile 时无意义（等价 no-op 分支）
    before = get_hermes_home()
    with profile_home_scope(other):
        assert get_hermes_home() == profile_home_for("plotter")
    assert get_hermes_home() == before


def test_session_key_launch_profile_stays_bare():
    """零回归：无 profile 时键就是裸会话 id（今天的单 profile 行为）。"""
    assert session_key_for(None, "20260920_085919_01c1a1") == "20260920_085919_01c1a1"
    assert session_key_for("", "abc") == "abc"


def test_session_key_distinguishes_profiles_with_same_id():
    """实测 plotter 与 default 存在同 id 会话——复合键必须区分。"""
    a = session_key_for("plotter", "same_id")
    b = session_key_for("scrna", "same_id")
    assert a != b


def test_session_key_roundtrip():
    for profile in (None, "", "default", "plotter"):
        sid = "20260920_085919_01c1a1"
        key = session_key_for(profile, sid)
        assert bare_session_id(key) == sid
        expected = (profile or None) if profile else None
        assert profile_of_session_key(key) == expected


def test_no_scope_keeps_process_home():
    before = get_hermes_home()
    with profile_scope(None):
        assert get_hermes_home() == before
    with profile_scope(""):
        assert get_hermes_home() == before
    assert get_hermes_home() == before


def test_scope_points_at_target_profile_home():
    home = profile_home_for("plotter")
    with profile_scope("plotter"):
        assert get_hermes_home() == home
    # restored after the block
    assert get_hermes_home() != home or profile_home_for("default") == home


def test_scope_nesting_restores_outer():
    outer = profile_home_for("steward")
    inner = profile_home_for("plotter")
    with profile_scope("steward"):
        assert get_hermes_home() == outer
        with profile_scope("plotter"):
            assert get_hermes_home() == inner
        assert get_hermes_home() == outer


def test_scope_restores_on_exception():
    before = get_hermes_home()
    with pytest.raises(RuntimeError):
        with profile_scope("plotter"):
            raise RuntimeError("boom")
    assert get_hermes_home() == before


def test_default_profile_home_is_the_root():
    root = profile_home_for("default")
    with profile_scope("default"):
        assert get_hermes_home() == root


def test_soul_loads_from_target_profile_inside_scope():
    """阶段 3 验收：作用域内 SOUL 加载指向目标 profile（而不是 launch profile）。"""
    plotter_home = profile_home_for("plotter")
    soul_file = plotter_home / "SOUL.md"
    if not soul_file.exists():
        pytest.skip("plotter profile 无 SOUL.md（本机未安装该 agent）")

    from agent.prompt_builder import load_soul_md

    with profile_scope("plotter"):
        text = load_soul_md()
        assert text, "scope 内应能读到目标 profile 的 SOUL.md"
        assert plotter_home == get_hermes_home()
