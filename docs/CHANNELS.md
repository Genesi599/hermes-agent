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
- [ ] 切片 4：**桌面频道面板**（新 pane `channel:<id>` + 侧栏频道行 + 只插入不跑 turn 的 composer）
- [ ] 切片 5 的收尾：归档原会话 `20260903_202943_020268`（迁移前已备份 state.db 到临时目录）

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
