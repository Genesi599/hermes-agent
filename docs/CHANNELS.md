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

## 群聊发言标记契约（2026-09-18 修，scripts 侧）

用户报：路由轮的**过程汇报**（路由结论/本轮动作/commit 号）整条贴进了群聊——那部分是思考内容，
只该留在 Hermes 自己的对话里。根因：prompt 只说"把要说的话放在回复**最后**"，而路由把**整条回复**
原样贴房间；Hermes 自发用"以下为贴进群聊的话："分隔，但路由不认。

修复（`channel_router.py`）：
- prompt 改**硬契约**：回复末尾必须有一行 `=== 发言 ===`，**只有这行之后**会贴进群聊；
  之前的一切（路由结论/执行过程/汇报）与『你问的/答』收尾块都是工作记录，留在自己的对话里。
- `_room_line()` 提取：`=== 发言 ===` 优先，回退识别旧分隔"以下为贴进群聊的话"（旧形态回复同样干净
  提取），再无标记才整条兜底；末尾统一剥掉收尾块——**收尾块形态按路径而异**（桌面轮 `**你问的**:`，
  后端 REST 轮是朴素 `---\n\n你问的…`，实测踩过），用宽松正则 `\n+-{2,}\s*\n+[^\n]{0,80}?(你问的|本轮结果)`
  匹配，且不误伤正文里的普通水平线（后随文本不含你问的/本轮结果不切）。
- 六种形态单测全过（新契约/旧分隔/粗体尾巴/朴素尾巴/无尾巴/正常水平线）；
  Book 房间已发的那条 #3917 已按此修剪（完整过程记录仍在 `Book · Hermes` 会话里）。

## Hermes 芯片动效全房间齐亮（2026-09-18 修，`a9c8ca0591`）

用户报：星阶发一条 "hi"，**所有项目**的 Hermes 芯片都开始动效。根因：`$agentActivity`/
`$agentUnreadAt` **只按 profile 作键**——每个房间的 Hermes 芯片各自轮询自己项目的
`<项目> · Hermes`，但全写进 `activity['default']` 这**同一个条目**（互相覆盖），而所有
Hermes 芯片也都读它 → 一个项目思考 = 全部 Hermes 芯片齐亮，未读绿点同理。

修复：`agentWatchKey({profile, titlePrefix})` 复合键（`default::<项目> · Hermes`；无前缀的
agent 芯片仍是裸 profile 键，行为不变）；`pollAgentWatch` 按复合键写，AgentChip 加 `watchKey`
属性按同一键读，`markAgentRead` 同步。部署后 CDP 实测（星阶路由轮真实运行中）：
星阶 Hermes=working，Book/胸腺/Tiddlywiki/Log/应用开发/Cashew/AI出题 全部 idle——一一对应。

## 任务栏幽灵角标（2026-09-18 修，`6e06b13967`）

用户报：任务栏出现"完成未读"角标，但没有任何可见 agent/行带这个状态。根因：角标 =
`$unreadFinishedSessionIds` 条数，而这个集合由通用的 working→idle 标记逻辑写入——路由轮在
**侧栏隐藏的** `<项目> · Hermes` 会话里结束时同样被记未读：行不可见、名册芯片的未读又是另一
个存储（`$agentUnreadAt`），于是角标计数 1 却无处可点。

修复：角标对账（`canonicalUnreadSessionIds`）套用**与侧栏完全相同的可见性规则**
（`isHermesConversation` + `agentProfileSet`，from session-agents）——隐藏会话不进 canonicalIds，
对账把残留 id 当 stale 从持久集合清除（启动即清扫存量幽灵）。名册芯片的未读点不受影响（那是
它自己的存储，隐藏会话的"可回读入口"本来就是芯片）。回归测试：隐藏的 `Book · Hermes` 不计数、
可见行正常计数（17 测试全过）。实测：包一层角标回调观测整轮隐藏思考-完成，计数从未变 1。

## 房间行内渲染 MEDIA: 引用（2026-09-18，`604bcb085a`）

用户报：带读回复里的图在 Hermes 自己的对话能看到，群里只显示 `MEDIA:C:\…` 裸路径。根因：线程侧
`renderMediaTags` + `#media:` 链接 → `resolveMediaDisplaySrc`（桥读文件转 data URL）→ ZoomableImage
一整条链；房间视图只用了 CompactMarkdown（无媒体能力）。

修复：`chat-messages.ts` 新增 `splitMediaRefs()`（复用同一套 MEDIA_LINE_RE/MEDIA_TAG_RE——语法
单一事实源，行式与内联式都认）；ChannelView 按段渲染——文字走 CompactMarkdown、媒体走新的
`ChannelMedia`（resolveMediaDisplaySrc 解析 + ZoomableImage 复用线程的看大图/下载外观；视频/音频
留一行名字，房间以文字为先）。CDP 实测 Book 房间：图 8-1(448×184)/图 8-2(256×256) 内嵌加载成功，
导入历史里的图 7-1/图 9-1 也一并渲染，裸路径文本消失。

## 房间活跃度盖到会话（2026-09-18，`10f56580af`）

用户报：有的项目在群聊发了消息，侧栏分组还在 yesterday。根因：分组/排序的键是**会话 recency**
（`max(last_activity_at, 最新消息时间)`——注意 DB 无 `last_active` 列，是 API 派生表达式
`_sql_session_last_active`），而房间模式的消息落 `channel_messages`，从不碰会话行。
修复：`append_channel_message` 落行后 `touch_session_activity`（单调；`last_active` 不是真列，
**必须走 touch_session_activity 写 `last_activity_at`**）。存量 21 房间按最后一条消息时间对齐；
CDP 实测分组：星阶/胸腺/Log/A股复盘/Book → Today，其余按真实时间落 Yesterday/Last week。
顺带清掉两个绑定会话已删除的孤儿测试频道（"回复确认二字"“修复 UMAP…”）。

## 房间人声头像（2026-09-18，`1b55a404e4`）

用户报"我的头像变了"：房间 SpeakerChip 对人声行写死 `🧑` emoji 兜底，从未接
`USER_SPEAKER.avatarImage`（线程视图用的正式用户头像）——进了群聊头像就变样。修：人声行
回退 `USER_SPEAKER`（名+头像图），agent 行不变；行自带 `author_avatar` 时仍优先。
CDP 实测：星阶/胸腺房间人声行均显示 user-avatar 图，无 emoji。


## 路由轮的 `-z` 回退凭空造"新项目"（2026-09-18）

用户报：在星阶房间问「管家给我发飞书了，但是怎么没发群聊？」，随后侧栏多出一个项目
**「推进星阶胸腺单细胞初步分析」**。查证（进程树 + 会话/房间表 + 日志）：

- 15:01:31 房间消息 #3957 → 后端 `_trigger_router` 拉起 `channel_router.py --message=3957`；
  这一轮路由**跑了两遍**：一遍正确续写 `星阶 · Hermes`（15:01:31.395 起、15:03:38 收尾），
  另一遍走了 `agent_dispatch` 的 `-z` 回退（进程实据：`-z <路由 prompt> --in …\hermes_board\星阶`，
  会话 `20260918_150133_c0a981`）。
- `-z` **永远新开会话**（`run_oneshot` 无 resume），新会话被起名器按看板内容命名成
  「推进星阶胸腺单细胞初步分析」（title_source=llm）；"每个会话都是房间"的自动晋升把它变成房间
  → 用户看到的就是"突然多出一个项目"。
- 旧命名护栏为什么失效：飞行改名只认**无标题**新行，而起名器在开篇消息落库那一刻就写了
  `derived` 标题，轮询永远慢一步；事后命名又传 `resumed_from`（旧会话 id），新会话始终没被命名成
  `<项目> · Hermes`——而 ensure-from-session 正是靠这个后缀排除「agent 自己的会话」。

修复（四层，防重复 + 防误晋升）：

1. `channel_router.py`：认领改成**原子**（`UPDATE … SET routed_at=? WHERE id=? AND routed_at IS NULL`，
   输家 `continue`）——同一条人声不允许被两个路由各派一遍。
2. `agent_dispatch._rename_newest_while_running`：只有 `title_source='user'` 的行才不碰；
   `derived`/`llm` 只是起名器对我们这条 prompt 的猜测，一律改写成派活名。实测：迟到的
   llm 标题行被改成 `星阶 · Hermes (4)` / source=user（随即被 ensure 排除）。
3. `agent_dispatch._rest_turn`：POST 抛错/读超时**不再等同于"没跑 turn"**——先查 transcript
   （`_prompt_landed`：最新 user 消息就是这条 prompt，或 live_status=working）再决定是否回退；
   5 分钟宽限与 1800s 硬顶两处 bail 同样先查证（已落地就继续等，硬顶返回空回复而不是开新会话）。
4. `channels.py` ensure-from-session：开篇消息是共享上下文 blob（`# 共享上下文 · `）的会话
   不晋升房间（reason=`dispatch_run`）——派活/路由轮的工作记录不是"项目"。

清理：伪房间 `ch_9b5e24e78d6a` 与该 `-z` 会话已删除（回答早已以 Hermes 名义贴回星阶房间 #3959）。
第 1–3 条对**每次新派活**立即生效（每次都是新进程）；第 4 条在保证后端重启后生效。

## 后端会话轮次接口的两次"假失败"（2026-09-18，同事故机制注记）

`POST /api/sessions/{id}/prompt` 在**空闲会话**上会**同步把整轮跑完**才回响应（`_run_prompt_submit`
inline），而 `_rest_turn` 的读超时只有 20s——短轮次能过、长轮次必超时；超时一旦被当成"后端拒绝"，
就会叠加 `-z` 回退（同一条 prompt 跑两遍、多出一个新会话）。修复把"失败"的判据从"HTTP 层有没有
异常"改成"**transcript 里这条 prompt 在不在**"。

## 名册芯片的右键菜单（2026-09-18，`939694f328`）

用户：「侧边栏的agent怎么没有右键选项」。会话行有 `SessionContextMenu`、profile 轨道方块有
`ProfileSquare` 右键菜单，**只有房间行下面的 agent 芯片没有**（`agent-roster.tsx` 的 `AgentChip`
以前只挂 `onClick`）——不一致造成的"看起来坏了"。

- 包一层 `ActionsContextMenu`（`components/ui/actions-menu.tsx` 通用套件，与 kebab 同一套 item 渲染），
  五项：打开对话 / 在新标签页中打开 / 新窗口（`canOpenSessionWindow()` 才出现）/ 复制 ID /
  标记已读（仅未读时出现）。
- **点击与菜单共用同一解析**：原来写死在 `onClick` 里的逻辑抽成 `openAgent(agent)`（会导航）与
  `resolveAgentTarget(agent)`（只查，供标签页/窗口/复制 ID）；Hermes 芯片对应 `hermesConversationFor(project)`。
- 菜单用哪个会话 id：常态取轮询已发布的 `$agentActivity[key].sessionId`；右键时**再查一次**——
  轮询按标题**前缀**匹配、点击要**精确名**，命名脚本追加过 `… (2)` 兄弟时两者会分叉（`lookedUpId ?? polledId`）。
- 刻意不套整套会话菜单：置顶/分支/删除在此处没有回调（套过来就是半屏灰项），且"重命名"会打断
  `<项目> · <智能体>` 的名字查找约定；智能体本体（SOUL/改名/颜色/导出）仍在 profile 轨道右键里管。
- 顺带修：该文件第 254 行 `join('\x00')` 里是**裸 NUL 字节**（Read 工具报"二进制"、grep 跳过整个文件、
  git diff 显示异常），改成 `'\u0000'` 转义——运行时同值，文件从此是纯文本。
- CDP 实测（打包版 `--remote-debugging-port`，端口读 `%APPDATA%\Hermes\DevToolsActivePort`）：
  对星阶房间的 Hermes 芯片发**真实右键事件**（`Input.dispatchMouseEvent` button=right）→
  菜单 `aria-label="Agent actions"`、四项可见且均可用；再点"复制 ID" → 剪贴板 `20260917_092821_6083f2`，
  DB 里该行标题正是 `星阶 · Hermes`——解析到智能体自己的对话，不是散落会话。
- 语言：文案进 `t.sidebar.row`（`openConversation` / `markRead` / `agentActions`），五语言 + `i18n/types.ts` 同步；
  `i18n/languages.test.ts` 键一致性测试通过。

## 群聊输入框：接上图片粘贴 + 打字卡顿的根因（2026-09-18）

用户：「群聊那个输出框怎么没法粘贴图片呀」＋「我在群聊那里打字感觉明显的卡顿」。

**为什么粘不进去**：房间的 `<textarea data-slot="channel-composer">` 从来没挂 `onPaste`/`onDrop`，
而房间又是**只认 `MEDIA:` 引用**才显示图（`lib/chat-messages.ts` 的 `splitMediaRefs`）。线程输入框那套
现成的桥（`window.hermesDesktop.saveImageBuffer` / `saveClipboardImage`）压根没接到房间上，所以粘图
在房间里是「静默无反应」，不是报错。

**卡顿的机制（可量化）**：draft 状态原本与消息列表同在 `ChannelView`，于是**每敲一个字**都重渲染整个
房间（最多 200 行），每行各自跑 `splitMediaRefs`（两条正则扫全文）；再加上 5 秒一次的轮询每次都返回
**全新对象数组**，一次轮询同样整房重解析。改法：
- `ChannelLine` 用 `memo` 包住、行内解析进 `useMemo`（依赖 `line.content`）；
- 轮询结果先过 `mergeMessages`：内容没变的行**复用旧对象**（React 跳过该子树），整房没变时**返回原数组**
  （React 连更新都不进）；
- draft 下沉到 `ChannelComposer`（自己的 state）——打字只重渲染输入框这一个组件；
- `ChannelView` 自身 `memo` 化，父层（chat surface 订阅很多）的重渲染不再灌进房间。

**测试**（`apps/desktop/src/components/chat/channel-view.test.tsx`，8 个）：把 `splitMediaRefs` 包一层计数，
断言「打 3 个字后解析次数不变」「内容无变化的轮询不增加解析」「轮询只多一行时恰好只多解析 1 行」，
外加「轮询带来新行时草稿不被冲掉」。**旧实现下 7/8 失败**，三条计数断言分别报
`24 !== 6`（6 行 × 3 次按键）、`12 !== 6`、`13 !== 7` —— 这组数字就是卡顿的量化证据。
粘贴 4 条：图片文件写盘+插引用、带空格路径加引号、纯文本粘贴不拦（`defaultPrevented === false`）、
空粘贴才问剪贴板且剪贴板无图时保持静默。

**实测**（打包版 + CDP；星阶房间 200 行；显示器 143Hz，一帧 7ms）：

| 指标 | 改前 | 改后 |
|---|---|---|
| 单次按键同步渲染（中位 / p90） | 6.0 / 6.5 ms | **1.8 / 2.1 ms** |
| 真实按键延迟（Event Timing，中位 / 峰值） | 24 / 32 ms | **16 / 24 ms** |
| 10.6 秒内掉帧（超 50ms 的帧数，最差一帧） | 3 次（91ms） | **1 次（62ms）** |
| 16 秒轮询长任务（超 50ms） | 1 次 68ms | **0** |

打字两项为同房间同口径（改前文档里曾同时挂着两个房间视图共 400 行，但触发重渲染的始终是被输入的那个
200 行房间）；掉帧一项改前是「两个房间视图同时轮询」，改后只剩一个，故只作趋势参考。

**粘贴实测**：造一张 240×140 测试图放进剪贴板 → 聚焦房间输入框 → CDP 发真实 `Ctrl+V`
（`Input.dispatchKeyEvent` rawKeyDown + `modifiers=2`）→ 输入框出现
`MEDIA: C:\Users\<user>\AppData\Roaming\Hermes\composer-images\composer_<stamp>_<rand>.png`
（走 `saveImageBuffer` 落盘到应用附件目录，与线程输入框同一条路径）。测完清空输入框、还原剪贴板、
删掉测试图与落盘副本，房间 DB 无新增消息。

**顺带**：`blobExtension` 从 `use-composer-actions.ts` 提到 `lib/media.ts`，线程与房间共用同一套
MIME→扩展名映射（原来那份是模块私有的，房间要用就得复制一份）。

**验收笔记（给下次驱动打包版的人）**：
- 房间视图会随应用界面切换**挂载/卸载**（同一坐标上可能同时存在多个 `[data-slot="channel-view"]`，
  底部还叠着线程的 `composer-rich-input` 建议输入层）——要测打字必须先用
  `document.elementsFromPoint()` 找出**当前置顶**的那个 `[data-slot="channel-composer"]` 再点它。
- 窗口被遮挡/最小化时 `document.visibilityState === 'hidden'`：轮询会停、渲染开销被低估，
  实测前先用 user32 `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` 把窗口显出来，并核对
  `hasFocus`/`visibility`。
- 用户随时可能在房间里打字：驱动 UI 前除了查 `live_status='working'`，还要看房间里最近有没有**用户**
  发言（本次用户就在我测量期间往房间发了一条 2706 字的共享上下文）。
