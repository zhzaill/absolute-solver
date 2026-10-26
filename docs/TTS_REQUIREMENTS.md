# TTS 要求手册

版本：v1.0  
日期：2026-10-26  
适用范围：Absolute Solver Hub、TTS Provider、Native Audio Body

## 0. 文档和输出位置

以下位置是本项目的强制约定：

| 内容 | 固定位置 | 规则 |
|---|---|---|
| TTS 要求手册 | `D:\11\Projects\Absolute Solver\docs\TTS_REQUIREMENTS.md` | 本文是 TTS 要求的唯一主文档 |
| 需求总目录 | `D:\11\Projects\Absolute Solver\docs\REQUIREMENTS_INDEX.md` | 各领域要求、优先级和完成状态的入口 |
| 项目推进规程 | `D:\11\Projects\Absolute Solver\docs\PROJECT_EXECUTION_METHOD.md` | 任务回收、排序、验收和归档流程 |
| WebSocket/音频协议 | `D:\11\Projects\Absolute Solver\docs\protocol.md` | 协议字段、媒体帧和 active Body 规则以此为准 |
| 协议补充说明 | `D:\11\Projects\Absolute Solver\docs\WIRE_PROTOCOL_V2.md` | 补充材料，不得与 `protocol.md` 形成第二套运行规范 |
| gRPC 迁移条件 | `D:\11\Projects\Absolute Solver\docs\GRPC_MIGRATION_TRIGGERS.md` | 只记录触发条件和迁移决策，不代表已经迁移 |
| 项目运行基线 | `D:\11\Projects\Absolute Solver\docs\PROJECT_LANDSCAPE.md` | 记录快照，必须标注日期，不作为实时监控 |
| 运行验收和故障报告 | `D:\11\Logs\` | 文件名必须包含日期、组件和主题 |
| gRPC 触发后的 proto | `D:\11\Projects\Absolute Solver\proto\absolute_solver.proto` | 未触发迁移前不得创建为“已完成”产物 |

生产语音的输出位置也必须固定：

- 正式输出：Hub 内存中的 PCM16，发送到当前 `active Body` 的扬声器；
- 禁止把生产音频输出到浏览器、聊天卡片或临时文件作为主链路；
- 诊断 WAV 只有在显式设置 `SOLVER_OUTPUT_WAV` 时才落盘，路径由验收命令明确传入；
- 诊断音频、截图和临时抓包统一放在 `D:\11\Logs\tts\`，不得写入长期记忆、trace 或仓库源码目录。

## 1. 目标

建立一条不依赖浏览器页面的正式语音输出链路：

```text
Hub -> TTS Provider API -> WAV -> PCM16 -> Native Audio Body -> 扬声器
```

TTS Provider 负责文本合成，Hub 负责权限、回合、路由和可观测性，Native Audio Body 负责实际播放。

当前基线：TTS API 调用、WAV 解码、PCM16 输出、WebSocket 音频协议和 active Body 路由已经具备；没有 active audio Body 时，不得宣称 TTS 完整闭环完成。

2026-10-26 状态：闭环已在真实环境验收通过（Provider 在线、Native Audio Body 在线并实际播放、故障与恢复可观测）。证据见第 12 节与 `D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md`。后续任何改动只要使 active audio Body 缺失或使实际播放不再成立，本结论即失效，必须重新验收。

gRPC 当前状态：保持 WebSocket v1，不进行迁移。三个触发条件（第三个非 Rust Body、外部开发者接入、版本兼容性成本超过每周 2 小时）均未成立。gRPC 相关的 trait、proto、并行服务和 Body 迁移均属于未开始的后续工作。

## 2. 架构边界

### 2.1 Hub

Hub 是唯一的语音输出编排者，必须负责：

- 选择并调用 TTS Provider；
- 固定模型、音色、文本语言和参考语言参数；
- 校验 HTTP 状态和 WAV 格式；
- 将 WAV 解码为单声道 PCM16；
- 通过 `say` 或 `say.audio` 发送到当前 `active Body`；
- 记录调用次数、延迟、输出字节数、错误和降级状态；
- 在 TTS 失败时发送字幕或文本降级响应。

Hub 不得把扬声器地址、浏览器页面或任意输出设备选择权交给 Persona、World 或模型。

### 2.2 TTS Provider

Provider 是无状态文本到语音服务，可由 GPT-SoVITS 网关、OpenAI 兼容服务或其他兼容实现提供。

Provider 不拥有 Hub 会话、Body 注册、权限或播放状态。

### 2.3 Native Audio Body

Native Audio Body 是正式播放端，必须通过 Hub WebSocket 注册，并声明：

```json
{
  "speaker": true,
  "media": ["pcm16-binary"]
}
```

Body 负责：

- 保持与 Hub 的 WebSocket 连接；
- 接收 `say` 元数据和对应 PCM 音频；
- 按 `turn`、`seq` 顺序播放；
- 报告连接断开，由 Hub 重新选择 active Body。

浏览器、DSH 工具卡和 HTML `<audio>` 不属于正式 Audio Body。

## 3. TTS Provider API

正式请求使用 OpenAI 兼容接口：

```http
POST {SOLVER_TTS_URL}/v1/audio/speech
Content-Type: application/json
```

请求体至少包含：

```json
{
  "model": "tts-1",
  "input": "要合成的文本",
  "voice": "xxx_trained",
  "response_format": "wav",
  "text_lang": "zh",
  "prompt_lang": "zh"
}
```

要求：

- `input` 使用 Hub 最终确定的回答文本；
- 中文音色默认 `text_lang=zh`、`prompt_lang=zh`；
- `response_format` 固定为 `wav`，直到 PCM 流式接口另行定义；
- HTTP 非 2xx 必须视为合成失败；
- 成功响应必须经过 WAV 解码校验，不能仅依据 HTTP 200 判定成功；
- 预期音频为单声道、PCM、16 bit，采样率以响应实际值为准；
- Provider 不可达、超时、返回非法 WAV 时，Hub 必须进入文本/字幕降级。

当前默认配置：

```text
SOLVER_TTS_URL=http://127.0.0.1:18080
SOLVER_TTS_MODEL=tts-1
SOLVER_TTS_VOICE=xxx_trained
SOLVER_TTS_TEXT_LANG=zh
SOLVER_TTS_PROMPT_LANG=zh
SOLVER_TTS_TIMEOUT_SECONDS=45
```

如果 Provider 位于另一台机器，必须使用受控隧道或内网服务地址；不得为了 TTS 将 GPT-SoVITS 直接暴露到局域网。

## 4. Hub 音频协议

Hub 到 Body 的正式输出使用现有协议 `docs/protocol.md`：

- 不支持二进制媒体的 Body 接收 JSON `say`，音频放在 `pcm_b64`；
- 支持 `pcm16-binary` 的 Body 接收 `say` 元数据，随后接收一个匹配的 `say.audio` 二进制帧；
- `turn` 和 `seq` 必须匹配；
- `sr` 必须是实际采样率；
- `mouth` 只用于表现层同步，不得替代音频数据；
- `say` 只发送给 active Body，不广播给待机 Body。

推荐优先使用 `pcm16-binary`，保留 JSON Base64 作为兼容路径。

## 5. 播放和回合要求

- 第一个合格的 Speaker Body 可成为 active Body；
- 同时连接多个 Body 时，只允许一个 Body 播放 `say`；
- active Body 断开后，Hub 必须选择仍在线的备用 Body；
- Body 必须按序播放同一回合的音频；
- TTS 输出为空时不得伪造音频播放状态；
- 播放状态应由 PCM 时长估算，并在回合完成后回到 `idle`；
- 音频 payload 不进入长期记忆、普通 trace 或监视器快照。

## 6. 错误和降级

至少覆盖以下情况：

| 情况 | Hub 行为 |
|---|---|
| Provider 未配置 | 返回文本/字幕降级，记录 `adapter.tts.degraded` |
| 连接失败或超时 | 记录结构化错误，返回文本/字幕降级 |
| HTTP 非 2xx | 保留状态码和安全错误摘要，不重试无限次 |
| 非 WAV 或 WAV 截断 | 拒绝播放，记录 TTS 解码错误 |
| 非 PCM16 或多声道 | 拒绝播放，进入降级 |
| active Body 不存在 | TTS 可继续计为合成成功，但必须明确记录“无播放接收体” |
| Body 在发送期间断开 | 不向其他 Body 重复广播当前音频；按 active Body 规则重新选择 |

默认不做无界重试。需要重试时必须有次数、总时限和回合幂等边界。

## 7. 安全要求

- TTS Provider 默认只监听服务器回环地址；
- 不把 Provider 管理接口暴露给浏览器或局域网客户端；
- Body 只能接收 Hub 授权的输出；
- Persona、World、模型和 DSH 不得直接指定任意扬声器；
- trace、日志和监视器不得写入完整 PCM、Base64 音频或敏感文本 payload；
- API 密钥（如使用云端 Provider）只能存在 Hub 运行环境，不进入前端 bundle。

## 8. 正式验收

### 8.1 Provider 验收

- `GET /healthz` 或 `/v1/models` 可探测；
- `POST /v1/audio/speech` 返回 2xx；
- 响应可解码为合法 WAV；
- 采样率、声道数、位深符合协议；
- 记录实际延迟和输出字节数。

### 8.2 Native Body 验收

- Body 注册成功并声明 `speaker=true`；
- Hub 状态显示正确 `active_body`；
- 触发一条 `persona.expression` 后收到 `say`；
- 二进制 Body 收到匹配的 `say.audio`；
- 实际扬声器播放出声音；
- 第二个 Body 不收到同一条 `say`；
- 断开 active Body 后备用 Body 能接管后续输出。

### 8.3 故障验收

- 停止 Provider，Hub 返回文本/字幕而不是卡死；
- 返回非法 WAV，Hub 不播放并记录错误；
- 没有 active Body 时，监视器明确显示“合成成功但无播放接收体”；
- 恢复 Provider 和 Body 后，后续回合恢复播放。

所有验收必须留下可复核产物：

- 命令输出、延迟、HTTP 状态和 Body 状态写入 `D:\11\Logs\` 下带日期的报告；
- 若需要听音，使用 `SOLVER_OUTPUT_WAV` 指向 `D:\11\Logs\tts\` 下的临时 WAV；
- 报告必须同时记录 Provider URL、音色、语言、active Body、传输模式和是否实际播放；
- 仅有 HTTP 200、WAV 文件生成或浏览器播放，不足以证明 Native Audio Body 验收通过。

## 9. 浏览器路线的定位

DSH TTS 工具和浏览器工具卡可以保留为：

- Provider 连通性诊断；
- 文本到 WAV 的人工测试；
- 开发期间的可视化辅助。

它们不得作为生产语音输出的验收依据，也不得替代 Native Audio Body、Hub active-body 路由或 WebSocket 音频协议。

## 10. 完成定义

当以下条件同时满足时，才可宣称 TTS 正式完成：

1. Hub 能通过 Provider API 稳定生成并校验 PCM16；
2. 至少一个 Native Audio Body 在线并成为 active Body；
3. `say` / `say.audio` 能到达该 Body 并实际播放；
4. Provider、Hub、Body 的错误和降级行为可观测；
5. Provider 故障、Body 断开和无 Body 状态均有明确处理；
6. 验收不依赖浏览器页面或自动播放策略。

完成状态必须以代码、测试和运行报告三者同时存在为准。文档中的勾选项、历史快照或模拟 Provider 单独不能作为完成证据。

2026-10-26 起，六条同时成立，且代码、测试、运行报告均已归档：本节视为满足，证据见第 12 节。

## 11. 与 gRPC 规划的关系

当前不要求实现 gRPC。WebSocket 计划项的状态如下：

- 二进制音频：已完成；
- active Body 切换：已完成；
- Hub 重启后的完整端到端恢复：已完成（2026-10-26 实跑；同时修复撕裂 trace 行阻断启动、以及新记录粘连撕裂行尾两处缺陷）；
- Presence 生产覆盖层反馈：部分完成，仍有提前撤销问题（不在 TTS 范围）；
- 协议主文档：运行规范以 `docs/protocol.md` 和 `src/wire.rs` 为准；`docs/WIRE_PROTOCOL_V2.md` 是补充说明，不得形成第二套运行规范；
- 未知 `type` 的宽容解析：已完成（2026-10-26；Hub 回 `protocol.error{code:"unknown_type",fatal:false}` 且连接不断，Body 记 `unknown.type` 后继续；含实跑冒烟）。

只有 gRPC 触发条件成立后，才按 `GRPC_MIGRATION_TRIGGERS.md` 创建 proto、实现协议适配层，并在迁移报告中记录输出位置和验收证据。

## 12. 验收记录

### 12.1 2026-10-26 正式验收

环境：Hub `0.3.0`（`LAN_HUB_ADDRESS:18100`，计划任务 `Absolute-Solver-Hub`）；Provider 为服务器回环 GPT-SoVITS v2Pro `9880` + 兼容网关 `18080`，`tts-1` / `xxx_trained` / `zh` / `zh` / `wav`；Native Audio Body 为操作者笔记本上的 `absolute-solver-body`（设备 `body-native-b`，`speaker=true`、`media=["pcm16-binary"]`，Windows 原生播放器）。触发路径为 Hub `POST /cortico/event` 的 `persona.expression`，不经浏览器。

| 验收项 | 结果 | 证据摘要 |
|---|---|---|
| Provider 探测与合成 | 通过 | `/healthz` `upstream_alive=true`；`POST /v1/audio/speech` 200 / 202,284 B / 6,061 ms（冷）/ 32 kHz 单声道 16 bit |
| Hub 解码与延迟 | 通过 | 162,560–189,440 B PCM16；热调用 1,357–1,922 ms；`adapter.tts.ok` |
| Body 注册与 active | 通过 | `body.handoff reason=first_body`；`active_body=body-native-b` |
| `say` + `say.audio` 与播放 | 通过 | `transport=pcm16-binary`；`pcm_ms=2540` / `player_ms=3481`；操作者听音确认 |
| 第二 Body 隔离 | 通过 | 非 active Body 的 trace 只有 `hello` + `body.handoff`，无 `say` |
| active 断开接管 | 通过 | 杀进程后 `active_body` 切到备用 Body，后续 `say` 由备用 Body 播放 |
| 无 active Body | 通过 | `tts_ok=1` 同时 `say_undelivered=1`、`last_say.reason="no active audio body"`、`tts.no_playback_receiver` |
| Provider 停止 | 通过 | `adapter.tts.error`（连接失败）+ `adapter.tts.degraded` + 字幕降级，Hub 不卡死 |
| 非法 WAV | 通过 | `tts returned invalid audio: missing RIFF/WAVE header`，拒绝播放并降级 |
| 恢复 | 通过 | Provider 恢复后下一回合重新出声 |
| 未知 `type` | 通过 | `tools/protocol-unknown-type-smoke.mjs` → `code=unknown_type fatal=false`，连接存活 |
| 重启恢复 | 通过 | 同一份含 2 条损坏行的 trace 正常启动，`turn` 从 trace 恢复，记录 `trace.recovered` |
| 代码与测试 | 通过 | `cargo fmt --check`；`cargo test` 50 项全通过；按 wire 类型重新生成 schema 无差异 |

可复核产物：`D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md`、`D:\11\Logs\tts\`（听音 WAV、Body trace、监视器与适配器快照、Hub trace 尾部）。

### 12.2 结论失效条件

出现以下任一情况，必须重新验收，不得沿用本节结论：

- 没有在线且被选为 active 的 audio Body；
- `say` / `say.audio` 到达但未实际播放；
- 故障、降级或"无播放接收体"状态在监视器与 trace 中不再可见；
- 验收依赖浏览器页面、自动播放策略或 DSH 工具卡。
