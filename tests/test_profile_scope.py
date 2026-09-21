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

from hermes_constants import get_hermes_home
from tui_gateway.profile_scope import profile_home_for, profile_scope


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
