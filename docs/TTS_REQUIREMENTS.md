# TTS 要求手册

版本：v1.1
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
| 未采纳协议设计稿 | `D:\11\Projects\Absolute Solver\docs\WIRE_PROTOCOL_V2.md` | 仅作历史参考；运行规范以 `protocol.md`、`src/wire.rs` 和 schema 为准 |
| gRPC 迁移条件 | `D:\11\Projects\Absolute Solver\docs\GRPC_MIGRATION_TRIGGERS.md` | 只记录触发条件和迁移决策，不代表已经迁移 |
| 项目运行基线 | `D:\11\Projects\Absolute Solver\docs\PROJECT_LANDSCAPE.md` | 记录快照，必须标注日期，不作为实时监控 |
| 运行验收和故障报告 | `D:\11\Logs\` | 文件名必须是 `YYYY-MM-DD-<component>-<topic>.md`；报告必须记录实际命令、结果、限制和证据路径 |
| TTS 诊断音频 | `D:\11\Logs\tts\` | 只有验收命令显式设置 `SOLVER_OUTPUT_WAV` 才允许写入；文件名必须带日期或回合标识 |
| TTS Body trace | `D:\11\Logs\tts\` 或 `D:\11\Logs\asr\` | 只能记录元数据、时长、字节数和播放结果，不得写入完整 PCM/Base64 |
| ASR 原始诊断录音 | `D:\11\Logs\asr\` | 默认不保存；只有明确授权并由命令显式指定路径时才可写入 |
| 截图、抓包和临时产物 | `D:\11\Logs\artifacts\` | 必须在报告中引用；不能替代文字结论 |
| 代码和测试 | `D:\11\Projects\Absolute Solver\` | 按现有源码目录放置；不得把实现写入日志目录 |
| 任务卡 | `D:\11\Projects\Absolute Solver\docs\tasks\` | `YYYY-MM-DD-<task-id>.md` |
| 生成 schema | `D:\11\Projects\Absolute Solver\schemas\` | 只能由 schema generator 生成，不得手工编辑 |
| gRPC 触发后的 proto | `D:\11\Projects\Absolute Solver\proto\absolute_solver.proto` | 未触发迁移前不得创建为“已完成”产物 |

输出位置的权威规则：

- 正式生产输出只能是 Hub 内存中的 PCM16，发送到当前 `active Body` 的扬声器；浏览器、聊天卡片和临时文件不能替代正式输出端。
- Provider 返回的 WAV 只能在 Hub 内存中解码；诊断 WAV 只有命令显式设置 `SOLVER_OUTPUT_WAV` 时才落盘。该路径由 Body 启动时校验（`diagnostic_wav_base`）：相对路径、仓库路径、`D:\11\Logs\tts-*` 兄弟目录和 `..` 逃逸一律拒绝启动；未设置时不得写出任何音频文件。
- 音频 payload 不得写入仓库、长期记忆、普通 trace、monitor 快照或任务卡；报告只能引用字节数、采样率、时长、哈希和播放结果。
- 报告、任务卡和诊断产物必须分别写入上表规定的位置；不得使用“当前目录”“桌面”或未声明的临时目录作为验收输出。

### 0.1 当前状态和设计边界

当前已实现并验收两种 TTS 路径：

- `SOLVER_TTS_SEGMENTED=0`：兼容路径。一次文本对应一次 Provider WAV 请求、一次 WAV 解码和一次 `say`/`say.audio` 输出。
- `SOLVER_TTS_SEGMENTED=1`：分段路径。Hub 按句切分文本，首段优先合成并发送，后续段以有界并发预生成，Body 按 `turn`/`seq` 顺序连续播放，并支持打断、失败降级、active Body handoff 和旧 Body 兼容。该路径已于 2026-10-26 实跑验收通过，证据见 `D:\11\Logs\2026-10-26-tts-segmented.md`。

Provider 侧流式 PCM 已完成可行性测量，但实现任务当前为 `blocked`。同一文本、同一音色下，直连 Provider (`streaming_mode=3`) 首块 966 ms / 总时长 4054 ms，首块/总时长 0.238，末 100 ms 内到达 0/28 块；经线上网关 (`stream=true`) 首块 3221 ms / 总时长 3227 ms，首块/总时长 0.998，末 100 ms 内到达 7/7 块。网关 `gateway.py:388-404` 收齐整段后才返回，导致假流式。分段 WAV 与 Provider 流式 PCM 是不同能力；解除阻塞前不得在 Hub 侧叠加第二套切片逻辑。证据与顺序见 `D:\11\Logs\2026-10-27-tts-streaming-pcm-可行性判定.md`。

### 0.2 TTS 服务 v2：局域网 OpenAI 远程服务（2026-10-27）

原本的 TTS 网关已升级为独立的局域网服务（`gateway.py` v2.0.0，仓库 `D:\11\Projects\absolute-solver-tts\gateway\`）：

- 监听 `0.0.0.0:18080`，提供 OpenAI 兼容接口（`/v1/audio/speech`、`/v1/models`、`/v1/audio/voices`）与公开的 `/healthz`；
- 客户端鉴权是多把可停用的 `sk-` 密钥；配置界面走独立管理员口令，两者权限分离；
- 浏览器配置界面：音色增删改与试听、客户端密钥、服务设置、上游进程、最近请求、接入示例；
- Hub 侧同步降级为纯 OpenAI 远程客户端：请求体只保留 `model`/`input`/`voice`/`response_format`，移除 `text_lang`/`prompt_lang`，新增 `SOLVER_TTS_API_KEY`。

生产验证（2026-10-27）：LAN 直连 401/200 鉴权、183 KB WAV 合成、Hub `tts_ok=1` 250,880 B PCM16。
证据见 `D:\11\Logs\2026-10-27-tts-openai-remote-service.md`。

## 1. 目标

建立一条不依赖浏览器页面的正式语音输出链路：

```text
Hub -> TTS Provider API -> WAV -> PCM16 -> Native Audio Body -> 扬声器
```

TTS Provider 负责文本合成，Hub 负责权限、回合、路由和可观测性，Native Audio Body 负责实际播放。

兼容路径时序是：

```text
完整文本 -> 单次 TTS 请求 -> 完整 WAV 返回 -> Hub 解码 -> 单次 say.audio -> 播放
```

分段路径时序是：

```text
完整文本 -> Hub 切分 -> 首段优先/后续段有界合成 -> 按 seq 发送 say + say.audio -> Body 队列连续播放
```

兼容路径的首音频等待包含完整文本的 Provider 合成时间；分段路径的首音频等待以首段合成和发送为准。两条路径都使用 WAV 响应，二进制媒体只降低传输开销，不改变 Provider 合成模型。

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

正式请求使用 OpenAI 兼容接口，Hub 侧只认"远程 OpenAI 端点"这一种形态：

```http
POST {SOLVER_TTS_URL}/v1/audio/speech
Authorization: Bearer {SOLVER_TTS_API_KEY}
Content-Type: application/json
```

请求体只包含 OpenAI 标准字段：

```json
{
  "model": "tts-1",
  "input": "要合成的文本",
  "voice": "xxx_trained",
  "response_format": "wav"
}
```

要求：

- `input` 使用 Hub 最终确定的回答文本；
- Hub 不发送 `text_lang` / `prompt_lang`；语言由 Provider 按文本推断（TTS 服务 v2 的 `auto_text_lang`），需要固定语言时由 Provider 侧音色配置决定；
- 当前 `response_format` 固定为 `wav`；分段路径是多个独立 WAV 请求，Provider 侧 PCM 流式接口仍未开始，不得把分段 WAV 响应当作流式输出；
- HTTP 非 2xx 必须视为合成失败（含 401 密钥无效、429 并发已满）；
- 成功响应必须经过 WAV 解码校验，不能仅依据 HTTP 200 判定成功；
- 预期音频为单声道、PCM、16 bit，采样率以响应实际值为准；
- Provider 不可达、超时、返回非法 WAV 时，Hub 必须进入文本/字幕降级。

当前默认配置：

```text
SOLVER_TTS_URL=http://127.0.0.1:18080
SOLVER_TTS_API_KEY=sk-...（TTS 服务 v2 起必填）
SOLVER_TTS_MODEL=tts-1
SOLVER_TTS_VOICE=xxx_trained
SOLVER_TTS_TIMEOUT_SECONDS=45
```

`SOLVER_TTS_TEXT_LANG` / `SOLVER_TTS_PROMPT_LANG` 已于 TTS 服务 v2 移除，不再读取。

TTS Provider 的实际实现是 TTS 服务 v2（`D:\11\Projects\absolute-solver-tts\gateway\`）：一个绑定
`0.0.0.0:18080` 的局域网服务，OpenAI 兼容接口 + 浏览器配置界面 + 上游 GPT-SoVITS 托管，客户端用
`sk-` 密钥调用。GPT-SoVITS 本体（`9880`）仍然只监听回环地址，任何客户端都不得直连它。

## 4. Hub 音频协议

Hub 到 Body 的正式输出使用现有协议 `docs/protocol.md`：

- 不支持二进制媒体的 Body 接收 JSON `say`，音频放在 `pcm_b64`；
- 支持 `pcm16-binary` 的 Body 接收 `say` 元数据，随后接收一个匹配的 `say.audio` 二进制帧；
- `turn` 和 `seq` 必须匹配；
- `sr` 必须是实际采样率；
- `mouth` 只用于表现层同步，不得替代音频数据；
- `say` 只发送给 active Body，不广播给待机 Body。

推荐优先使用 `pcm16-binary`，保留 JSON Base64 作为兼容路径。

兼容路径每个回答发送一个 `say` 和一个匹配的 `say.audio`。分段路径在同一 `turn` 下发送多个 `say`/`say.audio` 对，`seq` 为从 0 开始的段序号；可选 `seg_total` 和 `last` 用于段数与回合末段标记。旧 Body 忽略这两个可选字段后仍可接收音频。

## 5. 播放和回合要求

- 第一个合格的 Speaker Body 可成为 active Body；
- 同时连接多个 Body 时，只允许一个 Body 播放 `say`；
- active Body 断开后，Hub 必须选择仍在线的备用 Body；
- Body 必须按序播放同一回合的音频；
- TTS 输出为空时不得伪造音频播放状态；
- 播放状态应由 PCM 时长估算，并在回合完成后回到 `idle`；
- 音频 payload 不进入长期记忆、普通 trace 或监视器快照。
- 分段路径的 Body 持有有界段队列，按 `seq` 严格顺序播放；新回合会清理旧回合未播段，过期段不得插播。兼容路径仍按完整音频单次播放。

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

- GPT-SoVITS 上游（9880）只监听服务器回环地址，不得对外；
- 对外暴露的只有 TTS 服务（默认 `0.0.0.0:18080`）：客户端调用必须携带 `sk-` 密钥，配置界面必须走独立管理员口令；
- 配置界面（`/admin`）与客户端密钥权限分离：客户端密钥不能读写配置；管理接口的写操作要求会话 Cookie 加自定义请求头；
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

## 9.1 分段生成和流式 TTS

### 当前结论

分段生成已实现并通过实跑验收。任务卡为 `D:\11\Projects\Absolute Solver\docs\tasks\2026-10-26-tts-segmented.md`（`accepted`），报告为 `D:\11\Logs\2026-10-26-tts-segmented.md`。166 字文本实测切为 8 段，首段触发至实际出声 1,780 ms，触发至末段播完 40,241 ms，段间空档最大 2 ms，8/8 播放且 0 丢弃；69 项测试通过。验收同时覆盖打断、中途失败降级、播放中 handoff 和旧 Body 兼容，并修复了立体声 2 倍速与打断不清队列两个真实缺陷。段级回执（Body → Hub）于 2026-10-27 完成实现、隔离 Hub 验收、生产部署和生产 Body 实跑验收。生产 `turn=49` 正常路径为 2/2 播放；`turn=54` 在 3 段到达 Body 后被 `turn=55` 打断，Body 回执 1 played、2 skipped/superseded，3/3 对账 complete。生产证据见 `D:\11\Logs\2026-10-27-tts-segment-receipts.md`、`D:\11\Logs\2026-10-27-tts-segment-receipts-production-deploy.md` 和 `D:\11\Logs\2026-10-27-tts-segment-receipts-body-production.md`。


### Provider 流式 PCM 的最低要求

Provider 流式 PCM 进入实现前，任务卡必须明确以下边界：

1. 文本切分规则：中文标点、最大字符数、代码/数字/缩写保护和空段丢弃；
2. 回合字段：同一 `turn` 下的段序号、最后一段标记、取消/打断和过期段丢弃；
3. Provider 并发：并发上限、总超时、失败后的字幕降级和不可无限重试；
4. Body 队列：顺序播放、队列上限、当前段播放时打断、active handoff 和重复段去重；
5. 可观测性：每段合成延迟、首段就绪延迟、总段数、播放段数和未发送段数；
6. 输出位置：正式 PCM 仍只允许 Hub 内存和 active Body；若保存诊断 WAV，必须显式指定 `D:\11\Logs\tts\` 下的路径；流式报告必须写入 `D:\11\Logs\YYYY-MM-DD-tts-<topic>.md`；
7. 验收目标：至少同时报告“首块可播放延迟”和“完整故事播放总时长”，不能只报告 Provider HTTP 200。

在这些条件落地前，不能把 Provider 的单个 WAV 响应、现有段 `seq`、`mouth`、音频二进制帧或输入 `audio.up` 分片解释为已完成的 Provider 流式 PCM。

## 10. 完成定义

当以下条件同时满足时，才可宣称 TTS 正式完成：

1. Hub 能通过 Provider API 稳定生成并校验 PCM16；
2. 至少一个 Native Audio Body 在线并成为 active Body；
3. `say` / `say.audio` 能到达该 Body 并实际播放；
4. Provider、Hub、Body 的错误和降级行为可观测；
5. Provider 故障、Body 断开和无 Body 状态均有明确处理；
6. 验收不依赖浏览器页面或自动播放策略。

上述六条证明兼容完整 WAV 路径的 Native Audio Body 输出闭环；启用 `SOLVER_TTS_SEGMENTED=1` 时，还必须满足第 9.1 节的分段验收证据，才能宣称首段先播。它们不代表 Provider 侧流式 PCM 已完成；后者必须另建任务并提供独立报告。

完成状态必须以代码、测试和运行报告三者同时存在为准。文档中的勾选项、历史快照或模拟 Provider 单独不能作为完成证据。

2026-10-26 起，六条同时成立，且代码、测试、运行报告均已归档；分段路径另有独立验收报告。兼容路径和分段路径的结论均以对应开关、代码、测试和报告为准。

## 11. 与 gRPC 规划的关系

当前不要求实现 gRPC。WebSocket 计划项的状态如下：

- 二进制音频：已完成；
- active Body 切换：已完成；
- Hub 重启后的完整端到端恢复：已完成（2026-10-26 实跑；同时修复撕裂 trace 行阻断启动、以及新记录粘连撕裂行尾两处缺陷）；
- Presence 生产覆盖层反馈：部分完成，仍有提前撤销问题（不在 TTS 范围）；
- 协议主文档：运行规范以 `docs/protocol.md`、`src/wire.rs` 和 schema 为准；`docs/WIRE_PROTOCOL_V2.md` 是未采纳的历史设计稿，不得作为运行规范；
- 未知 `type` 的宽容解析：已完成（2026-10-26；Hub 回 `protocol.error{code:"unknown_type",fatal:false}` 且连接不断，Body 记 `unknown.type` 后继续；含实跑冒烟）。
- 分段生成（首段先播）：已完成并验收（2026-10-26，任务卡 `docs/tasks/2026-10-26-tts-segmented.md` 状态 `accepted`，报告 `D:\11\Logs\2026-10-26-tts-segmented.md`）：166 字 → 8 段，首段 1.78 s 出声、段间空档 ≤ 2 ms、总时长 40.2 s（基线 59.0 s）；打断、中途失败、播放中 handoff、旧 Body 兼容均已实跑。验收中修复了立体声 2 倍速播放与打断不清队列两个真实缺陷。段级回执实现、隔离验收、生产 Hub 部署和生产 Body 正常播放/打断均已完成；生产打断回合 1 played、2 skipped/superseded，3/3 对账 complete。报告：`D:\11\Logs\2026-10-27-tts-segment-receipts-body-production.md`。打断仍不能切断当前正在发声的那一块。120 秒整轮预算已由慢 Provider 实跑触发并记录在 `docs/tasks/2026-10-26-tts-turn-budget.md`。Provider 流式 PCM 已完成可行性测量但因网关缓冲而 blocked，不是未开始；见 `D:\11\Logs\2026-10-27-tts-streaming-pcm-可行性判定.md`。

只有 gRPC 触发条件成立后，才按 `GRPC_MIGRATION_TRIGGERS.md` 创建 proto、实现协议适配层，并在迁移报告中记录输出位置和验收证据。

## 12. 验收记录

### 12.1 2026-10-26 正式验收

环境：Hub `0.3.0`（生产 LAN Hub，计划任务 `Absolute-Solver-Hub`）；Provider 为服务器回环 GPT-SoVITS v2Pro `9880` + 兼容网关 `18080`，`tts-1` / `xxx_trained` / `zh` / `zh` / `wav`；Native Audio Body 为操作者笔记本上的 `absolute-solver-body`（设备 `body-native-b`，`speaker=true`、`media=["pcm16-binary"]`，Windows 原生播放器）。触发路径为 Hub `POST /cortico/event` 的 `persona.expression`，不经浏览器。

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
