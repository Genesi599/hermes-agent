# CHANNELS — 群聊作为一等实体（设计 + 切片计划）

> 用户 2026-09-17 定：群聊是 **agent 之间、以及人和 agent 之间交换信息的地方**，性质像公共看板，
> **本身不是一条会话、不属于任何 agent**。选定的做法是 **(b) 完整做频道实体**。
>
> 本文是落地设计。结论先行：**能做到，但它是一条新实体 + 新面板 + 改投递通路的多切片改动**；
> 每个切片单独可验证、且不破坏现有可用状态。

## 进度

- [x] **切片 1（存储 + API）**——`channels` / `channel_messages` 进 `SCHEMA_SQL`（声明式，老库自愈，
  live 库实测已出现）；`hermes_state.py` 的频道读写方法（`get_or_create_channel` / `get_channel` /
  `list_channels` / `append_channel_message` / `get_channel_messages` / `pending_channel_messages` /
  `mark_channel_message_routed`）；`hermes_cli/web_routers/channels.py` + 注册。
  两处实证（都在 **state.db 副本**上跑，绝不碰 live）：存储往返 PASS（幂等建频道、人/agent 各插一条、
  `display_metadata` 正确解码、`message_count` 递增、路由水位 1→0）；handler 往返 PASS（建→发言→列→读→
  pending→标 routed→未知频道 404）。⚠️ 路由在 dashboard 既有鉴权之后（无 token 401），没新增暴露面。
  提交：`6d8c948aae`（存储+文档）、`d293c99e1c`（API）。运行中的后端**重启后**才提供这些路由。
- [x] **切片 2（投递改插行）**——`_outbox_common.deliver` 先试频道：把出箱正文写成
  `channel_messages` 行（`author_kind='agent'` + `agent_label`/`agent_avatar`），**不打印任何东西**
  → cron 的 `prompt is None` 分支照样跳过 → **群聊那一轮 turn 消失**；没有频道时回退成老的"打印→attach"。
  项目名从该智能体的投递任务派生（`script == agent_outbox_<agent>.py` → `target_session_id` → 会话标题），沿用既有接线。
  实测：advisor 出箱放一条 → 脚本 **stdout 0 字节**，频道里出现 `730 agent 流程搭档 🧭 …`（测试行已删）。
- [x] **切片 3（路由触发）**——`scripts/channel_router.py`：扫 `routed_at IS NULL` 的人类消息，
  逐条派给 **Hermes**（它按主 SOUL 的路由流程用 `wake_agents.py` 并行唤醒），然后盖章 routed；
  **永远不输出 stdout**（否则 cron 会把输出当 prompt 跑一轮），留痕写 `logs/channel_router.log`。
  cron 任务 `频道路由`(`bb60ae377589`, `*/2`) 兜底；人发言后 API 用 `BackgroundTasks` 立即 `--message=<id>` 触发一次。
- [x] **切片 5（导入）**——`scripts/channel_import.py <项目名>`：把会话历史按原样搬进频道（内容/时间戳/
  `display_kind`+元数据）、按说话人归类、**跳过工具与管道行**（`role` 只收 user/assistant、
  剔 `{"output"` 与 `[System:`/compaction 前缀）、**把历史人类消息直接盖成已路由**（否则看门狗会把
  陈年消息全派一遍）。实测：星阶 805 条 → 导入 **210 条**（142 agent / 68 human；说话人 Hermes 122、
  杨航 68、管家 18、流程搭档 2），跳过 609 条。
- [x] **切片 4（桌面频道面板）——完成并实测点亮（2026-09-17）**：
  **根因**：我把 `include_router(channels)` 追加在 `web_server.py` **文件末尾**，而 `mount_spa(app)`
  在那之前（17915 行）就注册了 SPA/headless 的兜底 `@application.get("/{full_path:path}")`；
  Starlette 按注册顺序匹配 → `/api/channels` 永远落进兜底（那句 "Headless backend … web UI disabled" 的 404）。
  这同时解释了：为什么 `/api/skills`、`/api/cron/jobs`（注册更早）正常而我 404，以及
  "走桥拿 openapi 却看得到这些路由"（openapi 是完整 app 视角，与匹配顺序无关）。
  **修法**：注册移到 `mount_spa(app)` 之前。**实测**：桥 GET `/api/channels` → `星阶:212` ✓；
  随后 ChannelView 在星阶那一面渲染成功（200 行、说话人 杨航/Hermes/管家/流程搭档、输入框在位）。
  **临时镜像桥已拆**：投递现在只写频道、stdout 0 字节（群聊那一轮 turn 彻底消失，实测）。
  历史记录（保留作教训）：
  `lib/channels.ts`（频道 API 客户端）+ `components/chat/channel-view.tsx`（房间视图：按行渲染、
  每行 SpeakerChip、底部输入框 POST 一行不跑 turn、5s 轮询）+ `app/chat/index.tsx` 接线
  （会话标题对应的项目有频道时，该面渲染房间取代转写+聊天输入框）+ i18n 三处。
  **阻塞点（未解决）**：桌面桥 `hermes:api` 对 `/api/channels` 返回 404（headless 的 catch-all），
  而同一桥对 `/api/cron/jobs`、`/api/profiles/sessions` 正常 → 说明桥走到的那个后端没有这些路由。
  已试过重启 `hermes serve`(8803) 与 `hermes dashboard`(8806) 两个进程再重启应用，仍然 404；
  两个端口 curl 都是 401（鉴权中间件在路由匹配前就拦，所以 401 不能证明路由存在）。
  **排查进展（2026-09-17 二轮）**：
  - `hermes:api` 处理器（`electron/main.ts`）解析 `connection.baseUrl`（`ensureBackend(routeProfile)` 的返回），
    URL = `baseUrl + pathWithGlobalRemoteProfile(request.path, profile, …)`。
  - 桌面日志显示**两个后端**：主 profile 的 `serve --port 8803`（PID 15536/46808）+ steward 的
    `--profile steward serve --port 0` → 实际监听 **63676**（PID 39812/3392），启动时间都在我改动之后。
  - **两个后端的 `/openapi.json` 都有我的 4 条 `/api/channels*` 路由**（275 paths，实测列出）——
    所以"代码没加载"这个假设被排除。
  - 但桥对 `/api/channels`（带或不带 `profile=default`）都返回 404（`mount_spa` 的 catch-all body），
    而同一桥的 `GET /api/cron/jobs`、`GET /api/profiles/sessions` 正常。
  - ⇒ **结论：在 `hermes:api` 与 FastAPI 路由之间，这个路径被丢掉/改写了**。尚未排除的候选：
    ① `pathWithGlobalRemoteProfile` 对这种路径形状的改写；② 桌面/鉴权中间件里的路径白名单；
    ③ 桥实际连的是第三个实例（我没列到的端口）。
  - **三轮排查（决定性证据）**：
    - `hermesDesktop.getConnection()` 实测返回 `baseUrl=http://127.0.0.1:8803`、`mode=local`、`authMode=token`
      → 桥打的就是我 curl 过的那个后端。
    - **通过桥**拉 `/openapi.json`：275 条路由，**包含我的 4 条 `/api/channels*`** ✓ → 同一个 app 上路由确实在。
    - 但通过桥逐条试：`/api/cron/jobs` ✓、`/api/profiles/sessions` ✓、`/api/skills` ✓，
      而 `/api/tools` ✗、`/api/plugins` ✗、`/api/channels` ✗ —— 全是 `mount_spa` 的 catch-all body。
    - `pathWithGlobalRemoteProfile`（`electron/connection-config.ts`）只在 **global-remote** 模式才追加
      `?profile=`，本地是原样透传 → **排除**它是元凶（源码 + 它自己的单测都读了）。
    - **鉴权是"先按 `/api/` 前缀拦"**：随便一个 `/api/…` 假路径也返回 401，只有非 `/api` 路径才落 catch-all
      → 所以 **401 不能证明路由存在**（这条判据坑过我一次，记牢）。
  - ⇒ **结论：桥到 FastAPI 之间有一层"哪些 `/api/*` 对桌面可用"的子集门**（cron/skills/sessions 放行，
    tools/plugins/channels 不放行），而 openapi 是从**另一个**（完整）app 视角生成的。
  - **下一步**：读 `hermes_cli/subcommands/dashboard.py` 的 serve 路径 + `web_server.py` 里 app 的组装，
    找那个子集门到底在哪（对比 `/api/skills` ✓ 与 `/api/tools` ✗ 的注册差异），然后把 channels 纳入放行集合。
  （前端是惰性的：查不到频道就什么都不渲染，所以现状无回归。）
- [ ] 切片 5 的收尾：归档原会话 `20260903_202943_020268`（迁移前已备份 state.db 到临时目录）
- ⚠️ **临时桥（要记得拆）**：`_outbox_common.deliver` 现在是"写频道 + 同时打印"（打印仅在投递任务仍带
  `attach_to_session` 时发生）——因为桌面还看不到频道，打印让回复照旧出现在旧群聊视图里；
  频道视图点亮后把这段删掉，群聊那一轮 turn 才真正消失。

## 已核实的事实（决定了设计，不是推断）

| 事实 | 出处 |
|---|---|
| 消息表 `messages.session_id` 是 `REFERENCES sessions(id)` 的外键 | `hermes_state_common.py` messages DDL |
| 会话/消息 schema 在 `hermes_state_common.py`（DDL）+ `hermes_state_schema.py`（`_init_schema` 迁移链，最后一个 `current_version < 25`）；`SCHEMA_VERSION = 25` | `hermes_state_common.py:175`、`hermes_state_schema.py:770-1120` |
| HTTP API 是 FastAPI：`hermes_cli/web_server.py` + `hermes_cli/web_routers/{profiles,sessions,…}.py`（`GET /api/profiles/sessions` 在 `profiles.py`，`POST /api/sessions/{id}/prompt` 在 `sessions.py`） | 仓库内检索定位 |
| 现有"投递"= cron 任务 `attach_to_session` → 往那条会话**提交一次 prompt**（所以今天的群聊每来一条 agent 回复都要跑一轮 turn） | `cron/scheduler.py`（attach 分支）、`scripts/_outbox_common.py` |
| 桌面端把"会话"当一等对象：列表来自 `/api/profiles/sessions`，一条会话＝一个 pane（primary 或 `session-tile:<id>`），侧栏/未读/搜索/压缩都以会话 id 为键 | `apps/desktop/src/...`（前面几轮已核实） |

**因此**：频道不能复用 `messages`（外键 + 语义都不对），它需要自己的表与自己的面板。
但正因如此，**发消息不再需要 turn**——插一行就是发言，这正是"群聊不是会话"的实质。

## 数据模型（切片 1）

```sql
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,             -- 'ch_<8hex>'
    project TEXT NOT NULL,           -- 项目名（= 看板目录名，如 星阶）
    title TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    last_routed_message_id INTEGER    -- 路由水位：> 它的都是待路由的人类消息
);

CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role TEXT NOT NULL,              -- 'user' | 'assistant'（沿用渲染层的语义）
    author_kind TEXT NOT NULL,       -- 'human' | 'agent' | 'system'
    author_label TEXT,
    author_avatar TEXT,              -- emoji 字形；Hermes 走图片（渲染层已有回退）
    content TEXT NOT NULL,
    display_kind TEXT,               -- 沿用 agent_message / hidden 那套
    display_metadata TEXT,
    timestamp REAL NOT NULL,
    routed_at REAL                   -- 非空 = 这条人类消息已被路由过
);
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id, id);
```

- schema 走 `SCHEMA_VERSION 26`：`hermes_state_common.py` 加 DDL、`hermes_state_schema.py` 加 `current_version < 26` 一步。
  **纯增量**（只有 `CREATE TABLE IF NOT EXISTS`），不重建任何既有表。
- **落地前先在 state.db 的副本上跑一遍 `_init_schema`**，比对迁移前后的表清单与各表行数，确认只多了两张表。

## API（切片 1 后半）

新增 `hermes_cli/web_routers/channels.py`，在 `web_server.py` 注册：

- `GET  /api/channels?project=<名>` —— 列频道（含 message_count / updated_at）。
- `GET  /api/channels/{id}/messages?limit=&before=` —— 读消息（返回形状对齐现有消息投影，供桌面复用渲染）。
- `POST /api/channels/{id}/messages` —— **人发言**：插一行（`author_kind='human'`），返回该行；**不跑任何 turn**。
- `POST /api/channels/{id}/route` —— 触发路由（显式；也给看门狗用）。

## 投递与路由（切片 2）

- **投递改写**：`_outbox_common.deliver` 之外再加一个 channels 版本：把 agent 的 outbox 内容**直接插入
  `channel_messages`**（`author_kind='agent'` + `display_metadata`），不再 `attach_to_session` 提交 prompt。
  → 省掉每轮 turn、回复即时可见、且天然"公开"。
  ⚠️ Hermes 自己的 outbox 同理（`hermes_agents/hermes/outbox`）。
- **路由**：人发言后由谁触发路由——**不依赖桌面窗口开着**：
  - 首选：`POST /api/channels/{id}/messages` 内部**立即**调一次路由（交给 Hermes 自己那条对话判相关方），
    并给该消息打 `routed_at`；
  - 兜底：一个 `*/2` 的看门狗 cron（`channel_router.py`）扫 `routed_at IS NULL` 的人类消息补路由（应用没开时也不丢）。
- 路由动作本身仍走现有 `wake_agents.py`（并行唤醒 + 各自投递），只是投递改成插行。

## 桌面面板（切片 3，最大一块）

- 新 pane 类型 `channel:<id>`：复用聊天渲染（`ChatMessage` 投影 + `SpeakerChip`，所以头像/名字/公开性都现成），
  配上**只插入不跑 turn** 的 composer。
- 侧栏：频道按项目列出（与"会话行"并列但**不是会话行**），点名册挂在频道行上（参与者）。
- 未读/状态：沿用现有的 chip 状态（我已经用 `live_status` 给智能体芯片做了运行/未读），频道的"新消息"按
  `channel_messages.id` 与本地已读水位比较即可，不需要会话那套。

## 迁移与退役（切片 4）

- 把现有群聊会话 `20260903_202943_020268`（805 条）**导入**成频道：建 `channels` 行 + 复制消息（保留
  `display_kind`/`display_metadata`/时间戳）→ 历史不丢。
- 之后 `attach_to_session` 指向该会话的 cron 任务全部改指向频道（投递改写后的路径）。
- 原会话**归档**（不删），并停掉"群聊那一轮路由"——因为发言人不再是一个 turn。

## 风险与次序

1. **切片 1 会动用户 live 的 `state.db`**（schema 版本 +1，应用下次启动自动迁移）。所以切片 1 落地时必须
   **连 API 一起**（否则白背一次迁移风险），且先在副本上验证。
2. 切片 3 是最大的一块（新 pane 类型 + 侧栏 + composer），且要重新出包部署。
3. 迁移前**先备份 `state.db`**（切片 4 动历史数据）。
4. 每个切片结束时系统都必须可用；任何一步出错，退回"群聊=会话 + 投递门"的现状（那是今天已经在跑的形态）。


## 用户报「我在群里说话 hermes 怎么没反应」（2026-09-17 修）

**根因**：`scripts/channel_router.py` 的 `--message=<id>` 快路径（人发言后 API 用 `BackgroundTasks`
立刻触发的那条）**崩了**——它用原生 `sqlite3.connect` 查那一条消息，却没有 `row_factory`，
于是 `dict(row)` 抛 `TypeError: cannot convert dictionary update sequence element #0 to a sequence`；
子进程的报错进了被吞掉的 stdout，所以**外面看起来就是"发了消息没人理"**。
（另一条兜底路径——`*/2` 的 cron 看门狗——用的是 SessionDB，所以它一直是对的；但看门狗要等下一个整 2 分钟。）

**修了四处**（都在脚本里，脚本不在 git 仓库，改动只在磁盘上）：
1. `row_factory = sqlite3.Row` → 快路径可用（**这是用户实际撞到的那个**）。
2. **Hermes 自己的那条也贴进房间**：路由轮结束时把它的回复以 `author_label='Hermes'` 插进频道，
   并把 prompt 从"不要长篇回答"改成"把你要说的话放在回复最后（会以你的名义贴进群聊）"——
   否则按原设计它只在后台唤醒别人，房间里看不到它有任何反应（用户感知＝没反应）。
3. **先认领再派活**：`mark_channel_message_routed` 移到 dispatch 之前——快路径与看门狗会同时触发
   （实测 #740 就被路由了两次，唤醒了两轮 agent）；派活失败时把 `routed_at` 置回 NULL 交给看门狗重试。
4. 失败不再消失：整个派活块包 try/except 并写 `logs/channel_router.log`。


## 全局切换：每条会话都是它项目的房间（2026-09-18）

用户定调：**群聊+智能体是唯一的会话形态**——所有既有对话转成项目房间，以后新建的会话也是。
落地（commit `5f0ecc4633` + `29932fb38e`）：

### 存储：绑定按 id，不按名字猜

- `channels` 加 `session_id` 列（声明式 DDL；索引放 `DEFERRED_INDEX_SQL`——引用新列的索引必须等
  `_reconcile_columns` 先加列，放 `SCHEMA_SQL` 会在旧库上 executescript 炸"no such column"）。
- `get_or_create_channel(project, title, session_id=…)`：绑定优先于项目名（**改名不断链**）；
  未绑定的同名频道可被**认领**（星阶房间即此例——它出生于 weixin 线程）；同名他 session 房间
  **去重** `名字 (2)`，两条对话绝不并进一个房间。
- `import_session_into_channel`：会话历史一次性搬进频道（只搬 user/assistant "说过的话"，
  过滤规则同 `scripts/channel_import.py`；**人声盖 routed 章**——只有新行进路由；频道非空即幂等）。

### API：`POST /api/channels/ensure-from-session`

会话 → 房间的唯一提升入口。规则次序（**绑定检查在最前**，第一个房间出生于 weixin 线程，
平台来源不能把它拒掉）：已绑定 → 无标题 newborn → weixin/feishu 平台线程 → `· Hermes (n)`
维护者自对话 → **cron 仍在此输出的会话**（读 `cron/jobs.json` 的 `attach_to_session`+`target_session_id`；
Stelscala/A股复盘的 cron 往会话 transcript 写内容，转了房间用户就看不见了——**有意保持线程**）。

### 桌面：打开即房间；新会话一轮后成房间

`index.tsx` 的 room 查找从"标题==project"换成 `ensureChannelForSession(selectedSessionId)`；
`busy || awaitingResponse` 时跳过（流式中留在线程，回合落定才切）。**新会话的第一条消息仍是
普通线程回合**——正是它挣得标题（`title_source: llm`）的方式；回合完成 → ensure 建房+导入 →
视图切成房间。之后输入框就是房间的（发帖=插行+触发路由），会话 transcript 冻结为历史。

### 命名竞态（`29932fb38e`）

建房可能发生在正式命名落地前（实测 project 曾是首条消息回显）。ensure 的已绑定分支：
房间出生 <15min 且 project != 会话当前标题且目标名未被占用 → `rename_channel` 跟随正式标题。
更老的房间项目名**冻结**（改名会孤儿化看板目录/agent 会话命名）。

### 批量迁移（`%LOCALAPPDATA%\hermes\scripts\channel_backfill_all.py`，脚本不在 git）

2026-09-18 实跑：**19 条会话转房间**（视网膜项目/Tiddlywiki/B细胞清除项目/骨髓微环境/Hermes Sync
Android/应用开发/中性粒项目/Journal Club/game/脑和脑膜/探索/神经空间/Log/AI出题/改革与发展/胸腺/Book/
雨课堂/Cashew Local，共导入 ~3250 行），星阶**认领**既有频道；跳过 4 条（Stelscala、A股复盘=cron
输出会话；飞书平台；星阶 · Hermes）。规则与 ensure 接口逐字一致。

### CDP 实测（2026-09-18，09:3x）

- 视网膜项目（已转换）→ 房间 108 行（=导入数）✓；星阶回归 218 行 ✓。
- A股复盘（cron）→ 线程 ✓；星阶 · Hermes → 线程 ✓。
- **新会话端到端**：新建标签 → 发"链路自检" → 模型回"收到" + `title_source: llm` → 房间自动创建
  绑定（2 行导入、人声 routed）→ 视图切成房间 → ensure 改名跟随正式标题。测试会话/频道已删。

### 已知边界

- 侧栏仍是**会话行**（行点开=房间），不是频道一等列表——会话行即项目行的形态已可日用；
  "频道直接进侧栏+归档旧房间会话"留作后续整理。
- `补充 SKILL.md 图表工具文档` 频道由并行会话经同一机制自然产生（cli 会话被打开即成房），
  佐证机制对"任何来源的 interactive 会话"都成立。

## 名册随房间走：Hermes 芯片常驻 + 频道参与者（2026-09-18，`929b381c03`）

用户报：转换后的房间一个 agent 芯片都没有——名册（`agent-roster.tsx`）只从"投递 cron 挂在该会话"
推导（只有星阶挂了），`agents` 为空时**连 Hermes 芯片一起 return null**。按模型 Hermes 是每个房间
的管理者（群聊记录/黑板/调度），不该依赖恰好有投递 cron。

- `channels.participants`（JSON 数组）：`append_channel_message` 在 agent 行落库时把 label 并进
  （事务内读改写；Hermes 本人不进表，芯片由名册自渲染）。存量已回填：星阶=[管家,流程搭档]，其余=[]。
- 桌面 `roomBySession(sessionId)`：共享 30s TTL 的 session→channel 缓存（名册每行一个组件，不能
  每行每轮各拉一次频道列表）；`agentsForSession(jobs, sessionId, participants)` = 投递接线 ∪
  房间参与者（参与者按 label 反查 cron 接线补 profile/avatar，查不到也上芯片，仅名）。
- 渲染条件 `!agents.length && !room`：**是房间就渲染**，Hermes 芯片常驻第一，点击仍开 `<项目> ·
  Hermes`（没有则回落本行=它今天说话的地方）。
- CDP 实测：21 个房间全部有名册——星阶=Hermes+管家+流程搭档，其余 20 个=Hermes。
- 语义：被唤醒的 agent 在某房间**说过话**（投递按项目名插行）→ participants 自动添 → 芯片出现，
  无需为每个项目手配投递 cron。

## 「群里说话 → 冒出新项目」事故（2026-09-18 修，scripts 侧 + `b61ef468d2`）

用户在 Book 房间发"1"，系统冒出新项目「补充 epub-read SKILL.md 图表文档」。链式根因：

1. **派活会话裸奔**：`agent_dispatch.dispatch()` 的改名（`agent_session_name.py`）在**整轮跑完之后**才执行；
   运行中会话无名，被 llm 自动命名成**工作内容**的标题（"补充 epub-read SKILL.md 图表文档"）。
2. **路由轮被上下文劫持**：路由 prompt 只有"判断跟谁有关"，没防"继续旧工作"——共享上下文里满是
   09:21 的 epub-read 旧任务，模型把"1"当成继续干活的信号（33 条消息的真工作）。
3. 裸奔会话是**可见普通会话**（非 `· Hermes` 命名→不被过滤）→ 被打开/命名落地后 ensure 成了新项目。

修复（scripts 不在 git，只在磁盘；`channel_backfill_all.py` 同目录）：
- `agent_dispatch.py`：改 `Popen` + **运行中即改名**——进程起来后轮询 profile 库找"本轮新出现的无名行"，
  立即 `title_source='user'` 写入 `<项目> · <智能体>`（user 权威 > llm，自动命名再也盖不掉；
  45s 内赢不了则回落到原有的跑完后改名）。实测修后 8 秒即已命名 `Book · Hermes`。
  （曾试过"预建带名空会话 + `--resume`"——`--resume` 不认无消息的裸 DB 行，另起新会话，弃。）
- `channel_router.py` prompt 加**防劫持护栏**："这是一次路由判断不是干活；消息可能只是 '1' 那样的
  链路确认；上下文里的旧工作除非明确要求否则绝不要继续"；并删掉重复的日志行。
- ensure 接口（`b61ef468d2`）：`live_status=working` → 拒绝（另一个 tile 打开同一会话时不得把
  半截 transcript 导进房间）。

验证（重路由 #3906）：`Book · Hermes` 会话运行中即命名且被侧栏隐藏；回复 366 字落 Book 房间
（#3909）；无新会话/新频道；router.log 单条 "routed #3906 … posted to room"。残留清理：
被劫持的 33 消息会话、两个假项目频道（其一曾被年轻房间改名逻辑跟随成 "Book · Hermes"）已删。

## 房间无看板的空态（2026-09-18，`4519632ca0`）

用户报"好多项目都没有显示公共看板"。根因：看板栏的渲染条件是**看板文件存在**
（`content.present`，否则整栏不渲染），而看板目录只有星阶有过——19 个新转项目从未建过
看板文件。修两层：

- 桌面：`ConversationBoard` 加 `room` 属性——**房间（有绑定频道的会话）无看板文件也渲染
  看板栏**，空文件/无文件统一走空态文案（zh"看板还是空的。"/en"Nothing on the board yet."）；
  非房间会话无看板仍不渲染。
- 脚本（不在 git）：`agent_dispatch._ensure_board(project)`——**首次派活即建看板骨架**
  （`hermes_board/<项目>/{state.md,decisions.md}`，骨架一句话说明由 Hermes 维护），路由与
  唤醒共用此入口，新项目从此自动有看板。存量 19 个房间已补骨架（星阶跳过，有真实看板）。
- CDP 实测：视网膜项目（骨架）栏+骨架内容 ✓；game（临时删骨架）栏+空态 ✓。

## 「看不到 Hermes 在思考 / 点开没有思考记录」（2026-09-18 修，scripts 侧）

两个表象一个根因：**`hermes -z` 的 oneshot 根本不支持续接**——`run_oneshot()` 没有 resume 参数，
`--resume` 被静默忽略（实测：对有 12 条消息的会话 `--resume` 后原会话不动、另起新会话）。于是每轮
路由/唤醒都开**全新会话**：思考记录被撕碎在 `· Hermes (2)(3)…` 里（点开正式名那自然没有记录），
且 headless 轮次不置 `live_status`（名册芯片永远不动）——用户看不到"开始思考"。

修复：`agent_dispatch` 对**默认 profile 一律走桌面后端的会话轮次接口**（镜像 cron attach 的
`_submit_attached_prompt_via_backend`+`_await_attached_dialog_turn`：`POST /api/sessions/{id}/prompt`，
token 用 psutil 从 8803 进程 env 读；等待=轮询 live_status working→idle，回复=会话最后一条
assistant 行）。无既有会话则**预建带名行**（`title_source='user'`，REST 对空行照样能跑——实测），
出生即命名即隐藏；后端不可达才回退 -z+运行中改名（回退时空预建行删除，不留可见空壳）。

实测（胸腺项目）：dispatch → `resumed: 20260918_102212_f8874c`（落在既有 `胸腺项目 · Hermes`），
`live_status: working`（t+4s/t+8s）→ idle，消息 5→7，**零新建会话**。live_status=working 正是
名册芯片动效的驱动信号（working→arc 已于 `5897d9b637` CDP 实测）；芯片轮询 10s，比探测轮次
短的 Turn 可能错过动画窗口，真实路由轮（30s~数分钟）不会。

顺带整理：`Book · Hermes` 系重复会话归位——删除我的链路测试会话与 "1" 测试路由会话，
把 54 条真实"继续带读"思考的 `(3)` 升为正式名（existing_session_id 取最老匹配，此后续接它）。

**已知边界**：管家/流程搭档（非默认 profile）的派活仍走 -z（同名撕碎问题仍在），待按 profile
后端端口扩展 REST 或上游修 oneshot resume。
