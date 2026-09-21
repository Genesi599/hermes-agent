"""共享后端进程池 · 阶段 1：请求级 profile 作用域。

设计见 ``docs/design/shared-backend-pool.md``。

复用 ``hermes_constants`` 的 context-local override（上游为 remote 多 profile 设计，
注释原文 "for in-process, per-task scoping"）：在作用域内 ``get_hermes_home()``
及其全部下游（配置、SOUL、记忆库、skills 路径、``SessionDB()`` 默认库位置……）
自动指向目标 profile。

**零回归约束**：``profile`` 为空（或进程自身）时**不设 override**——行为与今天的
单 profile 进程逐字节一致。调用方在已有 override 的上下文里再次进入不同 profile
时，退出会正确恢复外层值（ContextVar token 语义）。
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

__all__ = ["profile_home_for", "profile_scope"]


def profile_home_for(profile: Optional[str]) -> Path:
    """该 profile 的 HERMES_HOME：default 在根，其余在 ``profiles/<name>``。

    统一走 ``hermes_cli.profiles.get_profile_dir``（官方解析，含自定义根）。
    """
    from hermes_cli.profiles import get_profile_dir

    name = (profile or "").strip() or "default"
    return Path(get_profile_dir(name))


@contextmanager
def profile_scope(profile: Optional[str]) -> Iterator[None]:
    """在目标 profile 的 HERMES_HOME 作用域内执行（空值 = 进程自身，零变化）。"""
    name = (profile or "").strip()

    if not name:
        yield
        return

    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(str(profile_home_for(name)))
    try:
        yield
    finally:
        reset_hermes_home_override(token)
