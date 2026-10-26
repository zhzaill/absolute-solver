# TTS 分段生成（首段先播）

任务 ID：tts-segmented  
需求来源：`docs/TTS_REQUIREMENTS.md` v1.1 §9.1、§11「分段/流式 TTS：未开始」；用户 2026-10-26 指令「任务卡，同时检查 `D:\11\Repos\Amadeus` 她们当初的设计」  
目标：把「一次文本 → 一次 TTS 请求 → 一次 `say`/`say.audio`」改为「按句切分 → 分段合成 → 首段先播 → 后续段按序补齐」，同时保持回合、顺序、打断与降级语义不变。  
优先级：P3（体验优化）。**不得抢占 P0/P1**；本卡落地前必须由用户把状态从 `ready` 推进到 `active`。  
状态：**verify**（2026-10-26 实现并实跑；验收报告 `D:\11\Logs\2026-10-26-tts-segmented.md`；未宣称 `accepted`，原因见 §9）

## 1. 范围

| 项 | 内容 |
|---|---|
| 允许修改 | `src/bin/hub.rs`（切分、分段调度、分段输出、观测）、`src/bin/body.rs`（段队列、顺序、去重、打断）、`src/wire.rs` + `docs/protocol.md` + `schemas/`（仅当新增可选字段）、`CHANGELOG.md` |
| 不在范围 | Provider 侧流式 PCM（GPT-SoVITS 流式分块）、语义 token 稳定性校验、首句音频缓存、AEC/VTS、gRPC、ASR、Presence、机器人、发布 tag |
| 前置条件 | Provider `18080`（上游 `9880`）在线；至少一个 active audio body（`speaker=true`、`media:["pcm16-binary"]`）；基线 `D:\11\Logs\2026-10-26-tts-story-timing.md` 可复核；用户把状态改为 `active` |
| 输出位置 | 代码在本仓库；**任务卡**：本文件；**验收报告**：`D:\11\Logs\2026-10-26-tts-segmented.md`；**诊断 WAV**：仅当命令显式设置 `SOLVER_OUTPUT_WAV`，路径必须在 `D:\11\Logs\tts\`；**Body trace**：`D:\11\Logs\tts\`；生成 schema 只能由 `absolute-solver-protocol-schema` 写出 |

## 2. 基线（本卡必须打败的数字）

`2026-10-26-tts-story-timing.md`：187 个中文字符，批量 WAV 模式。

| 指标 | 基线 |
|---|---|
| 触发被 Hub 接受 | ≈ 59 ms |
| Hub 合成延迟（整段） | 17,112 ms |
| 输出 PCM | 2,618,880 B / 32,000 Hz / 单声道 |
| PCM 理论时长 | 40,920 ms |
| Body 播放墙钟 | 41,793 ms |
| 触发 → 播放结束 | ≈ 58,996 ms |
| 折算 | RTF ≈ 0.42；语速 ≈ 4.57 字/秒 |

即：**当前首音频等待 = 整段合成时间**，约 17 s。

## 3. 七项边界决策（对应 §9.1）

### 3.1 文本切分规则

- 强边界（立即成段）：`。！？!?；;\n`，切点包含标点本身。
- 弱边界（仅在超过软上限时使用）：`，,、：:`，向前取最近的弱边界。
- 软上限：`SOLVER_TTS_SEGMENT_SOFT_CHARS`（默认 **24**）——超过后允许在最近的弱边界收束，避免整段过长。
- 硬上限：`SOLVER_TTS_SEGMENT_MAX_CHARS`（默认 **48** 字符）——到上限仍无可用边界时，在最后一个安全位置强制切并记 `tts.segment.hardcut`。
- 保护规则：不切开 ASCII 单词/URL、不切开 `\d+\.\d+`（小数、版本号）、不切开反引号内代码、不切开结尾的语气助词（`了/吗/呢/吧/啊/呀/哦`）。
- 丢弃：空段、纯标点段、纯空白段；合并：连续短段（< 6 字符）并入下一段，避免碎片请求。
- 首段特化：首段优先在第一个强边界结束；若首段超过软上限仍无强边界，使用弱边界；若仍无，按硬上限切。首段目标长度 12–28 字符。
- 切分必须是纯函数并带单元测试（输入 → 段数组），不得依赖 Provider。

### 3.2 回合字段

- 复用现有 `turn`；`seq` 改为**段序号**（0 起，单调递增）。
- `say` 新增两个**可选**字段（v1 增量，不改版本号）：
  - `seg_total: u32`（可选）——本轮段数；
  - `last: bool`（可选）——该段是本轮最后一段。
  旧 Body 忽略未知字段即可继续工作；新 Body 用 `last` 判定回合结束，不再依赖"`say` 只来一次"。
- 取消/打断：沿用 `speech.start` 递增 `turn`。旧回合任何未播段以 `turn != current_turn` 丢弃；Hub 端以 epoch（回合号）校验发送，过期段不投递。
- 过期段丢弃：Body 侧 `seq < next_expected_seq` 或 `turn != current_turn` → 丢弃并计数，不得插播。

### 3.3 Provider 并发与超时

- `SOLVER_TTS_SEGMENT_CONCURRENCY`（默认 **2**，硬上限 2；设为 1 即保守模式）。依据：单路实测 RTF ≈ 0.42，据此**推算** 2 路并发仍低于实时（**尚未实测**，实现第一步必须在同一 GPU 上实测 2 路并发 RTF，恶化则回落 1）。
- 每段沿用 `SOLVER_TTS_TIMEOUT_SECONDS`（默认 45）独立超时；整轮另设 `SOLVER_TTS_TURN_BUDGET_SECONDS`（默认 **120**），超预算后剩余段直接降级为字幕并记 `tts.turn.budget_exceeded`。
- 失败策略：**不做无界重试**。单段失败（连接失败、非 2xx、非法 WAV）→ 该段不发音频、只发字幕 cue，后续段继续；首段失败 → 整回合退回现有批量降级（字幕 only）。
- 合成顺序：第 0 段单独优先，段 1..n-1 进入有界并发池；段 i 就绪即按 seq 顺序排队发送（就绪乱序不影响播放顺序）。

### 3.4 Body 队列

- 内存队列 `BTreeMap<seq, PendingSegment>`，上限 `SOLVER_BODY_QUEUE_SEGMENTS`（默认 **32** 段）与 8 MiB PCM；超限丢弃最晚未播段并记 `tts.segment.dropped(reason=queue_full)`。
- 播放：严格按 `next_expected_seq` 顺序串行播放；只有 `seq == next_expected_seq` 可播，播完 `next_expected_seq += 1`。
- 断点续播：active handoff 后新 active Body 从 Hub 当前未播段号继续；已播段不重放（Hub 按"已发送且播放时长已过"推进，**不依赖 Body ack**——协议 v1 当前没有段级回执，若后续增加回执另开任务）。
- 打断：新回合/`speech.start` → 清空队列（含正在播放的后续段），当前 `PlaySync` 不可中断时最多再播完当前段，并记 `tts.interrupt_drain`。
- 空段/0 字节：不伪装播放，记 `tts.segment.empty`。

### 3.5 可观测性

monitor 新增（均为元数据，不含 PCM）：

| 字段 | 含义 |
|---|---|
| `tts_segments` | 本轮切分段总数 |
| `tts_first_segment_ms` | 首段合成完成耗时 |
| `tts_first_audio_ms` | 触发 → Body 开始播放首段 |
| `segments_sent` / `segments_played` / `segments_dropped` | 段级账目 |
| `tts_segment_latencies_ms` | 最近 8 段合成延迟（有界） |

trace：`tts.segment.split`、`tts.segment.ok`、`tts.segment.error`、`tts.segment.dropped`、`tts.turn.budget_exceeded`；`say` 记录增加 `seq/seg_total/last`，仍不写 `pcm_b64`。

### 3.6 输出位置

- 正式 PCM 只存在于 Hub 内存与 active Body，不落盘、不入 trace/monitor/长期记忆。
- 诊断 WAV：只有命令显式 `SOLVER_OUTPUT_WAV=D:\11\Logs\tts\<name>.wav` 才写；每段一个文件需带回合与段号。
- 报告必须写 `D:\11\Logs\2026-10-26-tts-segmented.md`，含命令、状态码、每段延迟、首段延迟、总时长、播放结果。

### 3.7 验收目标

必须**同时**报告以下三组数字，缺一不通过：

| 目标 | 阈值 |
|---|---|
| 首段可播放延迟（触发 → Body 实际出声） | **≤ 6,000 ms**（基线 17,112 ms 才出声） |
| 完整播放总时长（触发 → 播放结束） | ≤ 基线 `58,996 ms × 1.10`，且不得出现段间可听空档 > 1,500 ms |
| 段级完整性 | 段数 ≥ 3、`segments_played == tts_segments`、`segments_dropped == 0`（打断用例除外） |

## 4. Amadeus 已实现设计的核对与取舍

检查对象：`D:\11\Repos\Amadeus`（Python，GPT-SoVITS 内嵌流式）。**只取不变量，不搬实现**。

| Amadeus 位置 | 其做法 | 本卡取舍 |
|---|---|---|
| `llm/sentence_splitter.py:9-99` | 首句边界优先级：空白 → 日文标点 `。！？!?、，,；;…`（`min_japanese_boundary = max(4, min_chars//2)`）→ 句末语气词（`ですね/ますね/だね/よね/のね/かね/ね/よ/わ`，且其后还有文本才切）→ 安全阀 `max(min_chars*3, min_chars+24)` → 否则等待 | **采纳**结构：强边界 → 弱边界 → 硬上限；**改造**：日语语气词表换成中文助词/标点集；等待分支不适用（Hub 拿到的是完整文本，不需要等流） |
| `tools/text_utils.py` `STRONG_SENTENCE_ENDINGS = {. ! ? 。！？ \n}`；`_compute_text_sha1`；`_parse_sentence_seq("sentence_9_…")` | 强结束符集合、文本摘要做去重/缓存键、从 ID 解析序号 | **采纳**强结束符集合与"段号可从消息解析"；**暂不采纳**文本 SHA1 缓存（首句缓存属后续能力，见不在范围） |
| `tts/pipeline.py:59`（`MAX_SELECTABLE_TTS_CONCURRENCY = 2`）、`:269`（信号量）、`:425-455`（打断排空与重建） | 并发上限 2；打断用 epoch 递增并排空队列，避免旧任务占坑 | **采纳**：上限 2 + 可配 1（Rust `tokio::sync::Semaphore` + `JoinSet`）；epoch 即 `turn`，打断时排空未发送段并复位并发租约 |
| `tts/deadline.py` `SynthesisCostModel`（≥5 样本、长度差 2 倍才拟合）；`TTS_RTF_INITIAL=0.6`、`TTS_CHARS_PER_SEC=7.5`、`TTS_COVER_SAFETY_MARGIN_SEC=1.5` | 用历史样本拟合"字数→耗时"，与"可播放覆盖时长"比较决定是否等待 | **部分采纳**：首版用固定保守预算（我们的实测 RTF 0.42、4.57 字/秒），不做在线拟合；只保留 `cover = 已排队 PCM 时长 − 剩余合成预测` 这一个可解释判据用于日志 |
| `tts/playback.py:398-426` `_claim_stream_sequence`/`_release_stream_sequence`（`next_seq_to_play` 已过则丢弃） | 单一全局 `next_seq_to_play` 同时管普通队列与流式块；已过序号直接丢弃（天然去重） | **采纳**：Body 用单一 `next_expected_seq`，`seq < next_expected` 丢弃；**不采纳**其"普通队列与流式争抢"复杂度（我们没有第二套播放队列） |
| `tts/playback.py:448-471` `estimate_cover_seconds()` | 当前段剩余 + 待播段总时长 | **采纳**为观测字段（`cover_ms`），不参与控制流 |
| `tts/playback.py:639-689` `mark_turn_last_sentence` + 迟绑定 | 回合完成是"播放事实"：最后一句播完才触发完成；允许事后补绑 | **采纳**：`last:true` 段播完 → 回合完成；Hub 的 `idle` 计时改为按最后一段 PCM 时长 |
| `tts/latency_clock.py` `[LATENCY] stage=… ms=…`，锚点=LLM 流式请求发出 | 单锚点、单调时钟、阶段埋点 | **采纳**：锚点 `t0` = Hub 收到 `persona.expression`/`speech.end`；阶段 `split/segment_first/segment_ready/first_audio/played_done` |
| `tts/first_sentence_audio_cache.py`、`tts/semantic_stability.py`、`tts/aec_realtime.py`、`vts/` | 首句音频缓存、语义 token 塌缩防护、回声消除、口型同步 | **不采纳**（不在本卡范围；且语义稳定性属于 Provider 内部，Rust Hub 无法干预） |

结论：Amadeus 的分段思路与本卡一致——**单调序号 + 单一播放顺序 + epoch 打断 + 段级延迟埋点 + 首段优先**；差异在于它们是"LLM 流式出字 → 句子即时合成 → 音频块直送播放器"，我们是"Hub 拿到完整文本 → 切分 → 有界并发合成 → 按序发送"。因此我们不需要处理"文本未完结"的等待分支，也不引入 Provider 侧流式协议。

## 5. 验收条件（可执行、可观察、可判定）

1. **切分（单元测试）**：187 字基线文本 → ≥ 3 段、每段 ≤ 48 字符、无空段/纯标点段；含小数、URL、反引号代码、英文单词的文本不得在内部切开。
2. **首段先播（真实链路）**：`POST /cortico/event` 触发后，Body 实际出声 ≤ 6,000 ms；报告给出 `tts_first_audio_ms`。
3. **顺序与去重**：故意重发一段 → Body 丢弃并 `segments_dropped` 递增；乱序到达（人为延迟第 1 段发送）不得插播，播放顺序仍为 0,1,2…。
4. **打断**：播放第 1 段时发 `speech.start` 或新回合 → 旧回合后续段全部丢弃（`tts.segments_dropped > 0`），不串音。
5. **失败降级**：让第 2 段命中 Mock 502 → 第 2 段只有字幕、`tts.segment.error` 记录、第 3 段继续；首段失败 → 整回合字幕降级且不卡死。
6. **无 Body**：仍显示"合成成功但无播放接收体"（`say_undelivered`），不伪造播放。
7. **观测**：monitor 含 §3.5 字段；trace 含段级事件；`monitor.json` 与 trace 内不出现 `pcm_b64` 或 Base64 音频。
8. **总量**：同一 187 字文本「触发 → 播放结束」≤ 64,896 ms（基线 +10%），段间可听空档 ≤ 1,500 ms。
9. **回归**：`cargo fmt --check`、`cargo test` 全绿；`SOLVER_TTS_SEGMENTED=0` 时行为与当前批量路径逐项一致（用现有验收报告复核）。
10. **报告**：`D:\11\Logs\2026-10-26-tts-segmented.md` 必须同时给出首段延迟、段级明细、总时长、播放结果与回滚方式。

## 6. 风险与回滚

### 6.0 并行改动的协调（实现前必须核对）

- `src/bin/body.rs` 当前有**未提交**的 ASR 麦克风采集改动（新增 `cpal` 依赖、`SOLVER_CAPTURE_SECONDS`、采集模式退出路径）。本卡的分段队列必须在其合入后再接，避免同一函数（`run_connection`/`pump`）被两套改动覆盖。
- `schemas/absolute-solver.wire.v1.schema.json` 与 `src/bin/protocol_schema.rs` 也有**未提交**的 unknown-type 泛化改动。若本卡新增 `seg_total`/`last`，必须在同一工作树上重新生成 schema，并把两处改动一起提交，避免"生成结果互相覆盖"。
- `desktop/tauri-host/*` 的未提交改动与本卡无关，不回滚也不合并。

| 风险 | 缓解 | 残留 |
|---|---|---|
| Provider 并发把 P104 打满，单段延迟反而上升 | 并发上限 2、可配 1、RTF 实测 0.42 有余量 | 长文本 + 弱 GPU 时需再测 |
| 切分破坏语义（成语、引号、代码） | 硬上限 + 保护规则 + 单元测试用例集 | 极端文本仍可能读断 |
| 段间空档（合成跟不上播放） | 首段优先、并发 2、cover 观测；不足时降级为"少切几段" | 极短句密集文本可能空档 |
| 打断竞态导致串音 | epoch(=turn) 校验 + 队列清空 + 单一 `next_expected_seq` | 已进入 `PlaySync` 的当前段不可中断 |
| 旧 Body 不识别 `last`/`seg_total` | 字段可选、旧端忽略；不改变既有字段含义 | 旧 Body 仍只按到达顺序播放 |
| 观测字段膨胀 | 只加计数器与最近 8 段延迟 | — |

**回滚**：功能由 `SOLVER_TTS_SEGMENTED`（默认 0）门控；关闭即恢复批量路径。代码按单一 commit 提交，回滚即 `git revert <commit>`；不涉及 Provider、协议主版本或数据迁移。

## 7. 与手册的对应

| §9.1 要求 | 本卡位置 |
|---|---|
| 1 文本切分规则 | §3.1 |
| 2 回合字段（段序号/最后一段/取消与过期） | §3.2 |
| 3 Provider 并发、总超时、失败降级、不可无限重试 | §3.3 |
| 4 Body 队列（顺序、上限、打断、handoff、去重） | §3.4 |
| 5 可观测性（每段延迟、首段延迟、段数、已播/未发） | §3.5 |
| 6 输出位置（正式 PCM / 诊断 WAV / 分段报告） | §3.6、§1 |
| 7 验收目标（首段延迟 + 总时长） | §3.7、§5 |

## 8. 下一步（状态推进条件）

1. 用户确认本卡后，状态置 `active`，并按 §3 顺序实现（切分纯函数 → Hub 调度 → Body 队列 → 观测 → 门控开关）。
2. 实现完成置 `verify`，跑 §5 十条，产出 `D:\11\Logs\2026-10-26-tts-segmented.md`。
3. 通过后置 `accepted`，并回写 `docs/TTS_REQUIREMENTS.md` §11（分段/流式状态）与 `docs/REQUIREMENTS_INDEX.md` P3 行。


## 9. 实施结果（2026-10-26）

已实现：切分（软 24/硬 48/最小 6 字符、保护 ASCII/URL/小数/反引号）、有界并发合成（默认 2）、按 `seq` 有序发送、`seg_total`/`last` 可选字段、Body 段队列（32 段上限、重复/过期/跨回合丢弃）、cpal 连续播放（替换每段 PowerShell，消除 0.9 s 段间空档）、Hub 侧段级观测、分段诊断 WAV。

实跑：143 字 → 7 段；首段送达 +1,737 ms（Hub 首段合成 1,656 ms）；末段播完 +34,274 ms（音频总长 31,600 ms）；0 丢弃；听感经用户确认正常。测试 67 项全通过。

**验收过程中修复的真实缺陷**：立体声设备下按槽位填充导致语音以 2 倍速播放（`48000 Hz / 2 ch / F32`）。修复为按交错帧消费并加回归测试。该缺陷无法被时间指标发现（播放器按名义时长睡眠），只有听感能暴露。

与卡片的偏差（保持 `verify` 的原因）：

| 偏差 | 现状 |
|---|---|
| 整轮预算 `SOLVER_TTS_TURN_BUDGET_SECONDS` | 未实现，只有每段超时 |
| 队列 8 MiB PCM 上限 | 未实现，只有 32 段上限 |
| handoff 续播 | 未验证：Hub 不跟踪已播段，新 active Body 可能重叠或跳段 |
| Body 侧 played/dropped 进 monitor | 未实现：v1 无段级回执，仅在 Body trace |
| 打断 / 中途失败 / 连续播放空档 | 只有单元与代码路径，未实跑 |
| 旧 Body 兼容 | 未用旧二进制实跑 |

下一步（按优先级）：① 一段 30 s 文本出声跑一次，量段间空档与总时长；② 打断与中途失败用例；③ 预算与字节上限；④ 双 Body handoff 实跑；⑤ 再考虑流式 PCM（Amadeus 侧已有 `openai_sse` 协议可对齐）。
