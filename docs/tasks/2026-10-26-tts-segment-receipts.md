# TTS 段级回执（Body → Hub）

任务 ID：tts-segment-receipts
需求来源（建卡时）：用户 2026-10-26 指令「如果需要在 monitor 中显示 Body 侧段播放/丢弃计数，需要新增段级回执协议」；上游任务卡 `docs/tasks/2026-10-26-tts-segmented.md` §9 边界「Body 侧 played/dropped 只在 Body trace」。
目标：让 Hub 的 `/monitor.json` 能显示**Body 视角**的段播放与段丢弃计数，而不是只有 Hub 自己的 `segments_sent`。
优先级：P2（观测完整性；不改变播放行为）。
状态：**accepted**（实现与隔离验收 2026-10-27；生产 Hub/Body 正常分段与打断验收 2026-10-27；报告 `D:\11\Logs\2026-10-27-tts-segment-receipts.md`、`D:\11\Logs\2026-10-27-tts-segment-receipts-production-deploy.md`、`D:\11\Logs\2026-10-27-tts-segment-receipts-body-production.md`）

## 1. 为什么必须新开协议，而不是猜

协议 v1 的 Body→Hub 只有 `hello`、`audio.up`、`speech.start/end`、`telemetry` 等消息，没有"这一段播完了"的回执。因此 Hub 现在只能按**名义 PCM 时长**推算播放进度（`schedule_idle_after`），并把 `segments_played` 当作估算而不是事实。

在没有回执的前提下，任何"Body 侧计数"都只能是 Body trace 里的私有数字，不能进 monitor 冒充全链路事实。

## 2. 范围

| 项 | 内容 |
|---|---|
| 允许修改 | `src/wire.rs`、`docs/protocol.md`、`schemas/`（由 generator 重生成）、`src/bin/body.rs`（发送回执）、`src/bin/hub.rs`（接收、计数、monitor 字段）、`CHANGELOG.md` |
| 不在范围 | 改变播放顺序或打断语义；用回执做流控（改动播放控制）；Provider 侧流式 PCM；把回执写进长期记忆 |
| 前置条件 | 分段路径已验收（`2026-10-26-tts-segmented.md`）；Body 侧段队列已有 `played/dropped` 计数（现仅 trace） |
| 输出位置 | 任务卡：本文件；报告：`D:\11\Logs\YYYY-MM-DD-tts-segment-receipts.md`；schema 只能由 `absolute-solver-protocol-schema` 写出 |

## 3. 最低设计要求

1. **消息形状**：Body→Hub 新增段级回执，最小字段 `turn`、`seq`、`outcome`（`played` / `skipped` / `dropped`）、`reason`（有界枚举字符串）、`pcm_ms`（可选，用于对账）。**不得携带 PCM 或 Base64 音频**。
2. **方向与频率**：Body→Hub 单向；每段最多一次；丢弃不计逐段，按窗口聚合上报（例如每 1 s 或每 N 段一次），避免慢语义下的消息放大。
3. **兼容性**：v1 增量、字段可选、旧 Hub 必须能忽略未知类型（现有 `unknown_type` 已非致命）；旧 Body 不发回执时 Hub 必须回落到"按名义时长估算"，不得把"没有回执"当成"没有播放"。
4. **口径**：`segments_played` / `segments_dropped` 在 monitor 中必须能区分 Hub 视角与 Body 视角（例如 `segments_played_body`），不得让两个来源共用一个字段名。
5. **不参与控制流**：回执只用于观测与对账，不得据此改变发送顺序、并发、打断或 `idle` 切换（除非另有任务专门论证）。
6. **重放与乱序**：重复回执幂等；`turn` 过期的回执丢弃并计数，不得污染当前回合。

## 4. 验收条件

1. 正常分段回合：Body 回执数 == Hub 发送段数 == `tts_segments`，monitor 两个视角数字一致。
2. 打断回合：被打断段记 `skipped/dropped`，且 Hub 能按 Body 口径给出丢弃数（不再只靠 Hub 自算）。
3. 旧 Body 兼容：不发回执的 Body 仍能播放，Hub monitor 标注"回执缺失"，不报错、不卡 `idle`。
4. 协议回归：旧 Hub 收到新回执类型不致命（复用 `unknown_type` 用例）；`cargo test` 全绿；schema 由 generator 重生成并 diff 可读。
5. 报告必须给出同一回合的 Hub 视角与 Body 视角数字对照，并说明差异原因。

## 5. 回滚

回执为可选消息；回滚即 Body 停止发送（Hub 字段回落为 None），不涉及协议主版本或数据迁移。
