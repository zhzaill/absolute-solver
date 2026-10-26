# TTS 整轮预算在慢 Provider 下真实触发

任务 ID：tts-turn-budget
需求来源（建卡时）：用户 2026-10-26 指令「验证 120 秒整轮预算在慢 Provider 下实际触发」；上游任务卡 `docs/tasks/2026-10-26-tts-segmented.md` §9 边界「整轮预算未实跑触发」。
目标：证明 `SOLVER_TTS_TURN_BUDGET_SECONDS`（默认 120 s）在 Provider 明显慢于播放速度时**真的会打断分段的无限等待**，把剩余段降级为字幕，并在 trace/monitor 留下可复核证据。
优先级：P1（TTS 闭环的可靠性补充，不是新能力）。
状态：**accepted**（2026-10-26 实跑验收；报告 `D:\11\Logs\2026-10-26-tts-turn-budget.md`）

## 1. 范围

| 项 | 内容 |
|---|---|
| 允许修改 | `src/bin/hub.rs`（仅观测字段/记录文本）；本卡；验收报告 |
| 不在范围 | Provider 侧流式 PCM；段级回执协议；字幕接收方（Stage）验收；并发上限调整；`docs/protocol.md` 字段变更 |
| 前置条件 | 能在本机跑 `absolute-solver-hub`、`absolute-solver-body`；一个慢速 TTS 桩（每请求固定延迟）；至少一个 active Body |
| 输出位置 | 任务卡：本文件；报告：`D:\11\Logs\2026-10-26-tts-turn-budget.md`；桩脚本与 trace：`D:\11\Logs\artifacts\2026-10-26-tts-budget\`；**不产生诊断 WAV**（本卡不设 `SOLVER_OUTPUT_WAV`） |

## 2. 验收条件（可执行、可观察、可判定）

1. 预算用**默认值** 120 s，不通过环境变量收紧，以证明默认路径有效。
2. 慢 Provider 的单请求延迟满足：`整轮不可能在预算内完成`（本卡取 35 s/段 × 8 段 = 至少 140 s）。
3. 触发后 trace 必须出现 `tts.turn.budget_exceeded`，且记录 `elapsed`、`budget`、`degraded_from_seq` 三个数。
4. 超预算后的剩余段只发字幕 cue（`hub->stage`），不得再发 `say`。
5. monitor 的 `segments_sent + segments_dropped == tts_segments`，且轮次最终回到 `idle`（不得永久 `speaking`）。
6. 验收报告必须同时报告：首段合成延迟、触发→预算触发延迟、已发送段数、被降级段数、Provider 实际请求次数。

## 3. 实施结果（2026-10-26）

- 桩：`mock-tts.mjs`，`POST /v1/audio/speech` 固定 35,000 ms 后返回 3 s / 16 kHz / 单声道 PCM16 WAV（96,044 B）。
- Hub：`SOLVER_TTS_SEGMENTED=1`、`SOLVER_TTS_URL=http://127.0.0.1:18098`、`SOLVER_TTS_TIMEOUT_SECONDS=200`；**未设置** `SOLVER_TTS_TURN_BUDGET_SECONDS`（走默认 120）。
- Body：`listen-only`（注册为 active audio Body、接收段、不驱动扬声器），使验收只依赖 Hub 逻辑而不依赖声卡。
- 文本：156 字 → 8 段。
- 结果：`tts.turn.budget_exceeded` 在 `elapsed=140,060 ms`（budget=120,000 ms）触发，`degraded_from_seq=6`；6 段送达 Body，2 段降级为字幕；`state=idle`；`say_sent=6`、`say_undelivered=0`；测试 70 项通过。

## 4. 已知边界（不改写验收结论）

1. **预算不是独立计时器**：判定发生在"某一段返回"的那一刻（`tts.turn.budget_exceeded` 实测晚于 120 s 20 s）。若 Provider 完全挂死、一段都不返回，兜底是每段的 `SOLVER_TTS_TIMEOUT_SECONDS`（默认 45 s），不是整轮预算。
2. **在途请求不取消**：并发 2 意味着预算触发时可能已有请求在路上。本轮 Provider 共收到 8 次请求，只有 6 段进入播放，2 次请求白做（返回后丢弃）。Hub 丢弃 future 但服务端推理已消耗算力。
3. **字幕降级的接收方未验证**：本轮无 Stage 连接，降级的 2 条 `render.cue` 只进了 Hub trace（`hub->stage`），没有证明字幕真的显示。
4. **未证明扬声器出声**：Body 为 listen-only，本轮只证明"段被送达并被计数"，出声证据沿用 `2026-10-26-tts-segmented.md`。
5. 观测缺陷已修：`tts.segment.done` 原先把整轮耗时标成 `first_say`，导致 140 s 的降级轮看起来像"首段 140 s 才出声"。现拆为 `elapsed=` 与 `first_say=`（真实值 35,016 ms）。

## 5. 回滚

只涉观测文本，无行为变更；回滚即 revert 对应 commit。桩脚本与 trace 位于 `D:\11\Logs\artifacts\2026-10-26-tts-budget\`，可整目录删除，不影响任何生产路径。
