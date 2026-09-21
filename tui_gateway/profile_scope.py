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

__all__ = ["profile_home_for", "profile_scope", "session_key_for", "bare_session_id", "profile_of_session_key"]

# 复合会话键的分隔符：用 NUL 保证不可能与真实会话 id 冲突。
SESSION_KEY_SEP = "\x00"


def session_key_for(profile: Optional[str], session_id: Optional[str]) -> str:
    """进程内 ``_sessions`` 的键：跨 profile 时加 profile 前缀。

    背景（docs/design/shared-backend-pool.md §2.2）：会话 id 只在一个 profile 内唯一
    ——实测 plotter 与 default 会各自存在同 id 会话（如 20260920_085919_01c1a1）。
    共享进程里 `_sessions` 以会话 id 为键，两个 profile 的同 id 会话会互相覆盖。

    规则（**launch profile 保持裸 id**，零回归）：
    - ``profile`` 为空 → 返回裸 ``session_id``（今天的单 profile 行为）；
    - 否则 → ``f"{profile}\\x00{session_id}"``。

    边界纪律（施工图，见文档 §3B）：
    - **入口**（session.resume/create/prompt 的 handler）：用本函数构造进程内键；
    - **出站**（事件/快照发给客户端）：如需裸 id，用 :func:`bare_session_id` 剥离；
    - **DB 调用**（SessionDB 的查找/写入）：一律用 :func:`bare_session_id` 剥离后传。
    """

    bare = str(session_id or "")
    name = str(profile or "").strip()

    if not name:
        return bare

    return f"{name}{SESSION_KEY_SEP}{bare}"


def bare_session_id(internal_key: Optional[str]) -> str:
    """从复合键还原裸会话 id（无前缀时原样返回）。

    注意：profile 名本身不含 NUL（见 `^[a-z0-9][a-z0-9_-]{0,63}$` 的命名规则），
    所以"第一个 NUL 之后"就是裸 id；无 NUL 则整体即裸 id。
    """

    text = str(internal_key or "")

    if SESSION_KEY_SEP not in text:
        return text

    return text.split(SESSION_KEY_SEP, 1)[1]


def profile_of_session_key(internal_key: Optional[str]) -> Optional[str]:
    """从复合键取回 profile 名；裸 id 返回 None。"""

    text = str(internal_key or "")

    if SESSION_KEY_SEP not in text:
        return None

    name = text.split(SESSION_KEY_SEP, 1)[0].strip()

    return name or None



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
