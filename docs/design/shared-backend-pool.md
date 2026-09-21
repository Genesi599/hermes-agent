# 共享后端进程池：多 profile 单进程服务（设计）

> 状态：**设计已定，阶段 1 未开工**（2026-09-21 杨航批准硬推；分支 `feat/shared-backend-pool`）
> 目标读者：后续任何接手此改造的开发轮次（含其他 agent）

## 1. 为什么做

现在每个 agent（profile）一个常驻后端进程，每个进程约一两百 MB：

- 8 个 agent ≈ 16 个 python 进程（venv launcher + uv 真身各一）；
- 进程间无法共享解释器/框架/HTTP 栈/工具注册表/缓存；
- 几百 agent 时内存不可行，且"闲置回收"受限于渲染层全连接策略（杀→重连拉起）。

**目标**：一个后端进程服务多个 profile，框架与运行时只加载一份；每个 profile 的
加载退化为"装配它的数据"（毫秒-秒级），从而"任何 agent 一点就开"与"内存可控"同时成立。

## 2. 现状障碍（2026-09-21 勘察）

### 2.1 已在代码里的资产（为 remote 多 profile 模式而建——正好适用）

**关键结论：地基已铺好，改造是"补齐+推广"，不是从零造。**

| 资产 | 位置 | 说明 |
|---|---|---|
| `set_hermes_home_override(path) -> Token` | `hermes_constants.py:30` | **context-local** 的 HERMES_HOME 覆盖，注释原文 "for in-process, per-task scoping"——**为共享进程设计** |
| `get_hermes_home()` | `hermes_constants.py:114` | 解析顺序 override → env → 默认；**全仓库唯一真源**（约几百处调用自动跟随） |
| `get_process_hermes_home()` | `hermes_constants.py:142` | 忽略 override 的进程级取值（需要"进程自身"语义时用） |
| `get_hermes_home_override()` | `hermes_constants.py:45` | 读当前 override |
| `_db_for_profile(profile)` | `tui_gateway/server.py` | **按 profile 取 SessionDB 句柄**（launch profile → 共享句柄；其他 → 独立句柄由调用方 close） |
| `_profile_home(profile)` | `tui_gateway/server.py` | profile → home 解析 |
| `_load_cfg_raw()` | `tui_gateway/server.py:3199` | 配置读取**已按解析路径键控缓存**（注释：profiles don't clobber each other） |
| 用法范例 | `methods_session.py:716/771/801/846`、`compute_host.py:549/580` | `session.resume` 处理远程 profile 时：set override → 跑 → reset |

### 2.2 仍然进程级、需要按 profile 键控的部分

| 全局单例（`tui_gateway/server.py`） | 作用 | 迁移难度 |
|---|---|---|
| `_sessions: dict[str, dict]` | 活跃会话注册表（按 session_key） | 高：需 (profile, session) 复合键 |
| `_pending` / `_pending_prompt_payloads` / `_answers` | prompt 等待与回执表 | 高：同上 |
| `_db` | **launch profile 的**共享库句柄（单例） | 低：`_db_for_profile` 已解决"取对库"，只需执行链改用它 |
| `_sessions_lock` / `_prompt_lock` / … | 各锁 | 低：全局锁只损失并发，不影响正确性；可按 profile 降粒度（可选） |

### 2.3 缺口（本改造的核心工作面）

- **本地模式下执行链只有"launch profile"一条路**：`POST /api/sessions/{id}/prompt` 无 profile 参数
  → `_submit_session_prompt_sync` → `gw._get_db()` / `_find_live_session_by_key` 全部默认进程自身；
- **无"请求进入即设定 override 并贯穿整个轮次"的本地流程**（remote 模式在若干点手工 set/reset，未覆盖执行链全程）。

**因此阶段 1 的实际工作 = 把 2.1 的资产在本地执行链上串起来 + 把 2.2 的表按 profile 键控；不需要新造注册表抽象。**


## 3. 设计（修正版：复用既有 override 机制，不新造注册表）

2026-09-21 勘察发现上游**已为 remote 多 profile 建好地基**（见 2.1）。因此设计从
"新造 ProfileRuntime 注册表"**修正**为两步：

**A. 请求级 profile scope（复用 `set_hermes_home_override`）**

```python
from hermes_constants import set_hermes_home_override, reset_hermes_home_override

def with_profile_scope(profile: str | None, fn):
    """在指定 profile 的 HERMES_HOME 作用域内执行 fn；None → 进程自身（零变化）。"""
    if not profile:
        return fn()
    token = set_hermes_home_override(str(profile_home_for(profile)))
    try:
        return fn()
    finally:
        reset_hermes_home_override(token)
```

作用：`get_hermes_home()` 及其全部下游（配置、SOUL、记忆库、skills 路径、SessionDB
默认库位置……）**在该上下文内自动指向目标 profile**——这正是 remote 模式已在做、
本地模式缺的那一环。

**B. 进程级表按 profile 键控**（2.2 清单）

- `_sessions` / `_pending` / `_pending_prompt_payloads` / `_answers` → 复合键
  `f"{profile}\x00{session_key}"`（或嵌套 dict），读写都经统一访问器；
- `_db` → 执行链改用既有的 `_db_for_profile(profile)`（launch profile 返回共享句柄，
  其他返回独立句柄由调用方 close）；
- 锁保持全局（正确性无损，仅并发略降；后续可选降粒度）。

**关键约束**：`profile=None`/launch profile 时，**行为与今天逐字节一致**
（override 不设、共享 `_db` 句柄照用、表键退化为单 profile）——保证日常单 profile
使用零回归。

### 3B. 会话键控施工图（`_sessions` 及等待表）

**事实**：`_sessions` 以会话 id 为键（118 处读写点）；会话 id **只在一个 profile 内唯一**
（实测 plotter 与 default 各有 `20260920_085919_01c1a1`）→ 共享进程里必须区分。

**工具（已实现于 `tui_gateway/profile_scope.py`）**：
- `session_key_for(profile, session_id)` —— launch/空 profile **保持裸 id**（零回归），
  否则 `f"{profile}\x00{session_id}"`；
- `bare_session_id(key)` / `profile_of_session_key(key)` —— 还原。

**边界纪律（三处，**内部 118 处不用改**）**：
1. **入口**：`session.resume` / `session.create` / `session.prompt` 等 handler 在拿到
   外部 id 后，立即用 `session_key_for(profile, id)` 构造进程内键写入 `_sessions`；
   此后内部一律用 `session["session_key"]` 自洽读写；
2. **出站**：事件载荷 / `_session_info` / snapshot 需要裸 id 时经 `bare_session_id()`；
3. **DB 调用**：一切 `SessionDB` 查找/写入传 `bare_session_id()`（库文件本身已是
   per-profile，不需要复合键）。

**收敛点清单**（改动集中在这几处，而非 118 处）：
- `_find_live_session_by_key`（5 个调用点）——加 profile 感知；
- `_session_lookup_key` / `_emit(...)` 的 sid 参数传递链；
- 各 RPC handler 的入口（`methods_session.py` / `methods_prompt.py`）。



## 4. 迁移阶段（每阶段可独立测试与回退）

| 阶段 | 内容 | 验收 | 回退 |
|---|---|---|---|
| **1** | 引入 `ProfileRuntime` + `runtime_for()`；把 `_get_db()` 与 `_cfg_*` 两个最集中的入口参数化（`profile=None` 走默认，行为不变） | 现有 gateway 测试全绿；单进程手工 resume+prompt 一轮成功 | 纯新增代码，删掉即回退 |
| **2** | `_sessions` / `_pending` / `_answers` / 会话锁迁入 runtime（分区） | 单进程内两个 profile 各跑一轮，互不干扰 | 开关切回全局字典 |
| **3** | agent 构造参数化（config/SOUL/memories/tools/凭据按 profile 加载）；lease 写入（`server.py:1678` 唯一写点）按 profile 作用域 | 冷会话 resume 在指定 profile 下加载正确的人格与库 | 同上 |
| **4** | 执行类端点接受 `?profile=`；桌面路由切"共享后端 + scopePath"（复用既有 `resolveProfileBackendRoute` 机制） | 桌面点任意 agent 私聊能派活；两 profile 并发轮次互不串 | 桌面切回 pool 模式（保留 per-profile 后端） |
| **5** | 退役 per-profile 池后端（保留 `--profile serve` 作为单站/兼容路径） | 内存实测：N profile 由 N 份框架降为 1 份 | 恢复 pool 模式 |

## 5. 风险与纪律

- **热路径**：所有 agent 轮次都经此改造，任何阶段出问题影响全域 → 阶段间必须可切回；
- **单独分支**：`feat/shared-backend-pool`，不与日常修复混提；合并前跑全量测试；
- **并发写者**：本仓库有并行会话（其 WIP：`apps/desktop/src/lib/session-deltas.ts`、`tests/test_hermes_state_compaction_purge.py`）——改造期间避免触碰其文件区；
- **隔离与限流（伴随阶段 4/5 同批）**：按 profile 的并发上限、单轮次异常兜底（不能一个 agent 崩掉拖垮同进程）；权限边界靠 `hermes_home` 分区维持（不得放宽）；
- **性能前提**（已实测）：agent 轮次 CPU 空转（瓶颈在等模型 API，IO 密集）——同进程多路复用不会互相抢 CPU；GIL 在 IO 等待时释放。

## 6. 与内存收益的对照

| 状态 | 框架内存份数 | 备注 |
|---|---|---|
| 今天（8 profile） | 8（×双进程） | 16 个 python 进程 |
| 阶段 4 完成 | 1（+ 旧的按需保留） | 每个 profile 只增加"数据"占用 |
| 几百 agent | 1~2 | 池内分区，加载即装配 |
