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

执行链（`POST /api/sessions/{id}/prompt` → `tui_gateway.server`）**以进程为 profile 边界**：

| 全局单例（`tui_gateway/server.py`） | 作用 | 迁移难度 |
|---|---|---|
| `_hermes_home` | **一切 profile 隔离的锚点** | 高：数百处隐式引用 |
| `_db` / `_db_error` | 单个 SessionDB 句柄 | 中：`_get_db()` 已收敛为单一入口 |
| `_sessions: dict[str, dict]` | 活跃会话注册表 | 高 |
| `_pending` / `_pending_prompt_payloads` / `_answers` | prompt 等待与回执表 | 高 |
| `_cfg_cache` / `_cfg_mtime` / `_cfg_path` | 配置单例缓存 | 中 |
| `_sessions_lock` / `_prompt_lock` / `_cfg_lock` / `_session_resume_lock` … | 各锁 | 中：需降为 per-profile |
| `_branch_merge_apply_locks*` | 分支合并锁 | 低 |

补充事实：
- **`/api/profiles/*` 系列端点已支持 `?profile=`**（跨库读，桌面芯片轮询即靠它）；
- **执行类端点不支持**（`submit_session_prompt` 无 profile 参数）——这是"每 profile 一进程"的直接原因；
- 桌面侧路由已有 `shared` 概念（`resolveProfileBackendRoute` 的 `scopePath`，remote 模式已实现"一后端多 profile + `?profile=`"）——**桌面侧不是瓶颈，gateway 才是**。

## 3. 设计

引入 **ProfileRuntime 注册表**：把"进程级全局"逐个变成"按 profile 分区的注册表"。
默认 `profile = 进程自身 profile` 时行为与今天完全一致（零破坏渐进）。

```python
class ProfileRuntime:
    """All state that used to be process-global, scoped to one profile."""
    def __init__(self, profile: str):
        self.profile = profile
        self.hermes_home = resolve_hermes_home(profile)   # profiles/<p> 或根(default)
        self.db = None                                     # lazy
        self.sessions: dict[str, dict] = {}
        self.pending: dict[str, tuple[str, threading.Event]] = {}
        self.answers: dict[str, str] = {}
        self.cfg_cache = None
        self.locks = ...                                   # per-profile locks

_runtimes: dict[str, ProfileRuntime] = {}
_runtimes_lock = threading.Lock()

def runtime_for(profile: str | None = None) -> ProfileRuntime:
    key = profile or _current_profile_name()   # 进程自身 = 今天的默认路径
    with _runtimes_lock:
        rt = _runtimes.get(key)
        if rt is None:
            rt = _runtimes[key] = ProfileRuntime(key)
        return rt
```

规则：
- **所有**原全局引用改经 `runtime_for()` 获取；
- 端点从请求解析 profile（`?profile=` 或 body 字段），未提供则用进程自身 profile（**兼容旧行为**）；
- 跨 profile 的"全局"概念（如 RPC 方法表 `_methods`、常量）保持全局（只读）。

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
