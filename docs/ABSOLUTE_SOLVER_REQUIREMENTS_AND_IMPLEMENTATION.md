# Absolute Solver 需求拆分与实现说明

版本：0.1  
日期：2026-10-28（Asia/Shanghai）  
适用范围：`D:\11\Projects\Absolute Solver` 仓库及其可信局域网运行链路  
主要读者：后续接手开发、验收和运维的工程师

> 本手册把代码、协议和 `D:\11\Logs` 的运行证据放在同一张图上。计划文档只说明目标，不能单独改变状态。所有 `accepted`、`verified`、`blocked`、`pending` 判断都必须能回到代码、命令或运行报告。

## 1. 项目定位与原则

Absolute Solver 是 Cortico Persona 的跨设备运行与执行层。它让同一个 Persona 通过局域网出现在浏览器、桌面、手机、树莓派屏幕和 Coo 等客户端上；它不重新实现 Persona、记忆、聊天系统或桌宠渲染器。

职责边界如下：

| 部位 | 唯一职责 | 权威内容 |
|---|---|---|
| Cortico | Persona、Session、Memory、World、语义响应、工具选择和沉默决定 | Persona/World 语义状态 |
| Hub | 连接、Body 注册、turn/sequence、active Body、权限/Presence、Provider 编排、路由、回执和 trace | 执行与连接事实 |
| Body/Host | 本地采集、播放、显示、动作执行和事实回报 | 设备实际状态 |
| Provider | ASR、LLM、TTS 等能力提供 | 能力结果、耗时和错误 |
| Coo 原版运行时 | 桌宠 renderer、菜单、动作词表、聊天、TTS World 和 audio-play | Coo 自己的界面和运行时 |
| 网页 | Hub/Coo 的一个客户端表面 | 不拥有权限、Persona 或系统状态 |

核心原则：

- Cortico 决定 `respond`、`tool` 或 `silence`；Hub 不建立第二个 Persona。
- Hub 判断连接、目标和已生效的访问许可，放行后调用既有插件；不替 Cortico 规划工具动作。
- Body 只报告事实。`say`、TTS 成功或事件入队不等于实际播放或动作完成；实际结果以 Body 回执为准。
- Coo 的原 `/pet`、`figure-frame`、原生 `/socket`、菜单、打字、气泡、动作、聊天和 TTS 路径继续复用。Solver 不自绘“大肥鱼”或复制动作词表。
- 服务目录只读，摘要不带 token、上下文、事件正文、完整音频或凭据。
- 事件正文、ASR 转录、模型输出和工具返回值是低信任事实，不能通过文字自称“已授权”来提升权限。
- HTTP LAN 入口当前只适用于可信局域网；HTTPS、配对和中心认证仍是后续收束项。

明确排除：gRPC 迁移、Provider 流式 PCM、机器人运动/VLA、公开 SDK、独立监控面板、第二套工具执行系统、第二套 Persona/Memory、独立桌宠 renderer 和新的 Solver 动作沙箱。这些能力只有在明确触发条件满足后才另立任务。

### 1.1 状态判定规则

- `accepted`：代码落地、必要测试/实跑通过、证据写入规定位置，且限制已记录。
- `verified`：某条路径已通过可复核验证，但尚不足以宣称完整生产验收。
- `blocked`：已完成测量，存在明确外部或上游阻塞，不能把未验收分支写成完成。
- `pending`：目标或代码边界已明确，尚无足够验收证据。
- 本机验收不等于第二台设备验收；Coo TTS 不等于 Solver Native Body TTS；服务在线不等于用户授权；模型输出不等于执行完成。

## 2. 需求拆分与当前状态

| 领域 | 目标与权威归属 | 输入 → 输出 | 依赖与失败状态 | 证据位置与完成判据 | 当前状态 |
|---|---|---|---|---|---|
| 协议 | WebSocket v1、JSON 控制帧、可选 PCM16 二进制帧、未知类型兼容；权威为 `docs/protocol.md`、`src/wire.rs` 和生成 schema | `hello`、`audio.up`、`speech.*`、事件 → `turn.started`、`say`、`say.audio`、错误/回执 | 版本不支持或字段非法时给非致命/致命 `protocol.error`；不采用 `WIRE_PROTOCOL_V2.md` | 协议测试、schema 生成、`D:\11\Logs\2026-10-26-protocol-unknown-type.md`；帧语义和兼容测试通过 | accepted |
| Hub | 注册 Body、active Body、turn、音频路由、段级回执、Presence；权威为 `src/bin/hub.rs` | Body/Cortico 事件 → 路由、TTS/ASR 调用、monitor/trace、Body 回执 | Cortico/Provider/Body 断线时显式降级；Hub 估算与 Body 事实分开 | Rust hub 测试、TTS 正式验收、段级回执生产报告；正常/打断/旧 Body 缺回执均有结论 | 基础完成；中心认证有缺口 |
| Cortico / World | Persona 处理事件并选择表达、工具或沉默；Solver World 只读服务目录和投影入口 | World 事实、服务快照 → Persona 决策或工具请求；`persona.expression` 仅是表达请求 | paused 或不可达时不伪造回复；仍缺自然输入→Persona→表达→Body 的关联样本 | `src/cortico.rs`、`packages/cortico-world-absolute-solver/src/world.js`、运行调试日志；需要一条带 correlation ID 的自然回合 | 边界明确；关联证据 pending |
| Coo 投影 | 复用原 `/pet`、原生 `/socket`、菜单、打字、动作、气泡和聊天流 | 浏览器/WebView → Coo 原页面和原生 WebSocket | 原 Coo 不可达时投影返回 502；HTTP 下浏览器麦克风不可用 | `tools/host-projection.mjs`、Host 阶段一报告；根页、WebSocket、原 renderer 和状态码通过 | 本机 verified；第二设备 pending |
| TTS | Coo TTS → `tts.voice` → Host 浏览器 `audio-play`；Native Body 是另一条链路 | 文本 → WAV/PCM16 或音频附件 → 播放事实 | Provider 超时/网关缓冲时降级或 blocked；不能混用两条证据 | `2026-10-28-coo-tts-接入.md`、TTS 正式验收和段级回执报告；两条链路分别验收 | Coo 路径 accepted；第二设备 pending |
| 服务目录 | Host 健康探测后生成脱敏服务摘要；权威为投影代理 | 配置服务 → `/api/services`、`/services` | 不可达为 offline；配置不能单独声明 online | `tools/host-projection-lib.mjs` 单测、Host 报告；停止服务后出现 offline/过期 | 本机 accepted |
| ASR | Provider/WAV/Hub 音频链路可复核；实麦人工朗读条件已按任务制定者环境豁免 | WAV 或 `audio.up` → 转写/空结果/失败 | 低电平设备可能只得到“嗯”；不把该结果当目标短句通过 | `2026-10-26-asr-input-turn.md`、ASR 诊断报告；源 WAV 逐字转写和完整 Hub 回合成立 | verified/accepted（豁免条件） |
| 阶段二 | Host 接入、目标服务发现和一次访问放行 | Host 能力/在线事实 + 一次请求 + 许可 → 放行或事实拒绝 | 未接入、撤销、过期、断线必须失败；不另造登录体系 | 本手册第 7 节验收矩阵；尚无实跑报告 | 未开始 |
| 阶段三 | Body/Host 环境事实进入 Cortico，Cortico 选择工具，Hub 只放行 | 环境变化 → Persona 决策 → 既有插件 → Coo/设备回执 | 重连需重新读快照；拒绝只返回事实，不替模型规划 | 本手册第 8 节验收矩阵；尚无实跑报告 | 未开始 |
| 发布与安全 | 凭据轮换、HTTPS、配对、trace 连续性、版本命名 | 配置/构建/备份 → 可回滚发布证据 | 无中心认证、明文 LAN、旧文件名版本不一致 | 相关 Logs、发布检查记录；完成前不称对外 Release | 未收束 |

## 3. 各部位实现说明

### 3.1 Cortico、Persona 与 World

代码入口：`packages/cortico-world-absolute-solver/src/world.js`、`src/ENV_PROMPT.md`、`src/config.js`；Solver 的 Hub 事件入口为 `src/bin/hub.rs` 的 `/cortico/event`。

- World 的 `pushEvent` 或工具结果只表示事实投递/读取成功；Persona 是否处理、回应或沉默由 Cortico 决定。
- `solver_services` 只读读取 `/api/services`，返回服务 id、名称、类型、状态、Host、地址、版本和能力；它不授予权限、不执行插件、不传输音频。
- `webUi()` 提供当前投影网页、`/services` 入口和使用说明。网页是客户端入口，Cortico 管理 WebUI 仍是服务器 loopback 管理控制台。
- `persona.expression` 表示 Persona 请求表达，不代表 TTS 已成功，更不代表 Body 已播放。
- Persona 不从事件正文获得权限；结构化环境摘要只能提供事实，不能复制 Persona 的宪法、记忆或状态。

### 3.2 Host 投影服务

代码入口：`tools/host-projection.mjs`、`tools/host-projection-lib.mjs`、`tools/coo-audio.js`。默认配置见 `tools/host-projection.example.json`；端口可由 `SOLVER_PROJECTION_PORT` 覆盖。

| 路径 | 作用 | 事实边界 |
|---|---|---|
| `/` | 同源代理 Coo 原 `/pet` | 原 renderer、菜单、聊天和动作仍由 Coo 返回 |
| `/coo/pet` | `/pet` 的显式别名 | 与根入口相同 |
| `/socket` | 双向代理 Coo 原生 WebSocket | 透传上行/下行，不解释动作语义 |
| `/services` | 只读服务目录页面 | 不承载聊天、权限或音频控制 |
| `/api/services` | 健康探测后的脱敏目录 JSON | 不含查询参数、凭据、完整响应 |
| `/api/coo/status` | 读取 Cortico WebUI manifest 中 Coo、TTS、audio-play 状态 | 只返回白名单字段 |
| `/api/coo/audio` | 读取新的 `tts.voice` 音频句柄列表 | 首次打开不回放历史；只登记新句柄 |
| `/api/coo/blob` | 转发已登记音频附件 | 不接受任意句柄，不列出音频历史 |
| `/coo-audio.js` | 用户手势后轮询并播放新音频 | 浏览器播放事实不冒充 Hub Body 回执 |
| `/hub/app` | Solver 原型/回退页面代理 | 不是 Coo 主对话入口 |
| `/cortico/event` | 受限转发到 Hub 的事件入口 | 不绕过 Hub 语义和权限边界 |
| `/ws` | Hub WebSocket 代理 | 使用 Hub v1 协议 |

可选 HTTPS 由 `SOLVER_PROJECTION_TLS_CERT`、`SOLVER_PROJECTION_TLS_KEY`、`SOLVER_PROJECTION_TLS_PORT` 开启。HTTP LAN 页面不是 secure context，因此不能把浏览器麦克风能力写成已完成。投影层故障应只影响投影，不影响 Cortico、Hub 或 Body。

不能做的事：代理完整 Cortico 管理 WebUI；暴露 token、上下文、事件正文或完整音频历史；把 `/services` 当聊天页面；复制 Coo renderer、动作词表、Persona 或聊天系统。

### 3.3 Hub

代码入口：`src/bin/hub.rs`；协议权威：`docs/protocol.md`、`src/wire.rs`、`schemas/`。

- `/ws` 接受 Body/客户端连接；首帧为 `hello`，声明设备和能力。
- `/state`、`/monitor.json`、`/turn/{turn}` 用于运行状态与观测；摘要不应包含完整上下文和音频。
- `/cortico/event` 接收版本化 Persona/World 事件；普通 World 事件归档，不自动开启 Hub LLM 回合，`persona.expression` 可进入表达/TTS 路径。
- `/presence/intent`、`/presence/revoke` 是当前受限 Presence 流程，需要服务端 token 和 Host allowlist；在线不等于许可。
- `/host/connect` 创建短时一次性 Host Panel 邀请，不能代替中心认证。
- `persona.expression`、`say`/`say.audio`、`render.cue`、`segment.receipt` 的语义必须区分接收、发送、合成、实际播放和回执。
- Hub 维护估算的 `segments_sent`/`segments_dropped` 与 Body 事实的 `segments_*_body` 两套视角；重复回执幂等，旧 Body 无回执只能标 `missing`。
- Hub 不承担第二个 Persona 决策，不替 Cortico 执行全部工具；现有 Hub 直连 LLM 只能作为明确标记的降级路径。

### 3.4 Body

代码入口：`src/bin/body.rs`。

- 首先注册设备 id、显示/扬声器/字幕和媒体能力。
- 接收 `turn.started`、`say`、`say.audio`、`render.cue`，按 turn/seq 排队、顺序播放、采样率转换和打断。
- `say.last` 透传到播放事件；一次性 Body 只有播完最后一段才允许结束回合。
- 每个段发送 `segment.receipt`，结果为 `played`、`skipped` 或 `dropped`，只做观测，不参与控制流。
- 麦克风采集通过 `audio.up` 上送；低电平或全零输入必须作为设备事实处理。
- 真实播放结果只能以 Body 回执为准；旧 Body 没有回执时标为 `missing`，不能推断“已播放”。

### 3.5 Provider

- ASR：接收 WAV/PCM 音频，输出转写、空结果或失败分类。Provider/WAV/Hub 链路已验证；两次低电平实麦只出“嗯”的事实已记录，当前实麦人工朗读条件按任务制定者豁免。
- LLM：只提供生成能力，不持有 Session/Memory 权威；上下文、预算和降级由 Cortico 或 Hub 的明确路径管理。
- TTS：OpenAI 兼容 `/v1/audio/speech`，支持 WAV/PCM16、超时和降级。Coo `world:tts` → `tts.voice` → `audio-play` 与 Solver Native Audio Body 是两条独立链路，证据不可互相替代。
- 流式 PCM：直连 Provider 测量为真流式，经网关变成整段缓冲，当前 `blocked`；不纳入阶段一闭环。

### 3.6 Coo 适配边界

- 形象为 `figure=whale`、`scheme=deepseek`，即大肥鱼。
- renderer 使用 Coo `/pet` 和 `figure-frame`；动作沿用 `pet_say`、`pet_act`、vocab 和 body runtime。
- 对话沿用 Coo `desktop-pet` 原生 `send`、历史和回执；投影代理不再丢弃网页上行消息。
- TTS 沿用 Coo `world:tts` 生成 `tts.voice`，`audio-play` 可本机播放，Host 页面可消费同一登记附件。
- Solver 不复制 Coo 的动作词表、聊天流、Persona、TTS 合成或桌宠模型。

## 4. 阶段一已实现内容与证据

阶段一是独立 Host 投影进程，不改 Hub/Body 控制流，也不修改 Coo 安装目录源码。已实现的事实：

- 根页面和 `/coo/pet` 代理 Coo 原 `/pet`；原页面标题、renderer、菜单、打字、气泡和动作入口已在本机浏览器验证。
- `/socket` 双向透传 Coo 原生 WebSocket；原页面上行交互继续由 Coo 处理。
- `/services` 和 `/api/services` 提供健康探测后的脱敏服务目录；配置本身不会把服务标为 online。
- `/api/coo/audio` 首次打开跳过历史事件，从新 cursor 读取 `tts.voice`；`/api/coo/blob` 仅转发已登记附件。
- `cortico-world-absolute-solver@0.2.1` 通过 Cortico API 6 的 `webUi()` 显示投影网页、服务目录和使用说明；`solver_services` 为只读工具。

证据：`D:\11\Logs\2026-10-28-host-projection-stage1.md`、`D:\11\Logs\2026-10-28-coo-tts-接入.md`、`docs/tasks/2026-10-28-host-projection.md`。当前限制是第二台 LAN 设备尚未人工打开，HTTP 麦克风不可用，LAN 配对/认证未完成，Cortico paused 时缺真实 Persona 自然回合。

## 5. 阶段二：Host 接入与一次访问放行

阶段二只增加一次访问的网络许可，不把 Hub 变成新的工具执行器，也不冻结尚未决定的新 wire 字段。

### 5.1 目标数据流

```text
目标设备启动 Host
→ Host 连接 Hub
→ Host 声明服务和 Body 能力
→ Cortico 读取当前 Host/服务事实
→ Cortico 或既有插件提出一次访问
→ Hub 核对来源、目标、有效接入状态和许可
→ 允许则路由，拒绝则返回事实失败
→ 插件完成调用
→ Host/插件回报结果
```

### 5.2 职责、输入输出和任务边界

| 参与者 | 输入 | 输出 | 任务边界 |
|---|---|---|---|
| Host | 本机服务、能力、连接状态 | 注册/心跳/服务摘要、执行结果 | 不自授予权限，不把网页正文当授权 |
| Cortico/既有插件 | 当前结构化事实、用户确认、工具参数 | 一次访问请求和关联 ID | 决定语义和插件动作，保留既有确认策略 |
| Hub | 来源 Host、目标服务、许可状态、关联 ID | 放行、拒绝、过期、撤销事实 | 只核对网络访问和记录事实，不规划模型下一步 |
| 使用者控制面 | 可核验的请求摘要 | allow/reject/revoke | 是许可来源；事件文本自称授权无效 |
| 目标服务 | 合法请求 | 结果或错误 | 不负责 Solver 的 Persona/权限状态 |

任务拆分：先复用现有 `/host/connect`、Presence/Host 接入机制，补齐 Host 在线、能力声明、目标发现、一次许可、撤销/过期和 trace 对账；不另造登录体系，不把所有 Coo 确认逻辑搬进 Solver。

建议的抽象关联关系（字段名称以最终协议决策为准）：请求必须能关联来源设备、目标服务、访问目的、环境变化关联 ID、许可期限和结果；不要提前把此处示意字段冻结为新的 wire schema。

### 5.3 阶段二验收矩阵

| 验收 | 通过条件 | 失败事实 |
|---|---|---|
| 未接入 Host | 不显示为可用且不能接收请求 | 目录显示 stale/offline；请求拒绝 |
| Host 上线 | 能发现真实 Host 和能力 | 无连接/无能力声明则不可用 |
| 一次真实调用 | 正确目标收到一次请求并有结果 | 超时、错误或重复必须可对账 |
| 无许可 | 访问被拒绝，不触发目标插件 | 记录拒绝原因和关联 ID |
| 撤销/过期 | 后续新请求失败 | 旧结果不被伪造为新授权 |
| 断线 | 断线后不再发送新请求 | 结果标明 disconnected/expired |
| 伪造授权 | 文本“已授权”不能改变放行结果 | 仍按 Hub 许可事实拒绝 |
| 对账 | 请求、许可和插件结果可由关联 ID 串起 | 缺一环标为 pending/failed |

完成判据：至少一次真实目标服务调用满足上述链路，并有独立日志；未满足前保持 `pending`。

## 6. 阶段三：环境事实与 AI 决策

### 6.1 目标数据流

```text
Body/Host 观察环境
→ 投递有界事实
→ Cortico Persona 决定响应、沉默或工具调用
→ Hub 核对目标和访问许可
→ Cortico 原插件执行
→ Coo/Body 反映结果
→ 回执和状态重新进入 Cortico
```

### 6.2 接口边界

- Body/Host 上报环境变化、设备状态、连接状态和实际执行结果；不要上传不必要的完整正文或音频。
- Hub 生成当前 Host、服务、权限和最近变化的结构化快照；快照是事实，不是 Persona 状态。
- Cortico 可读取快照，也可接收“已生效”的状态变化通知；权限变化不应把大量安全说明塞进模型上下文。
- 重连后必须重新读取快照，不能依赖漏掉的单次事件。
- Hub 返回 allow/deny/expired/revoked 等事实，不替模型规划下一步。
- Coo 仍由原 renderer/body/tool 执行动作；Solver 不复制动作词表。
- 收到工具请求不等于工具完成；必须等待插件结果或失败回执。

### 6.3 阶段三验收矩阵

至少完成一条真实且可关联的：

```text
Body/Host 环境变化
→ Cortico 决策
→ 工具请求
→ Hub 放行
→ 插件执行
→ Coo/设备状态变化
→ 执行回执
```

| 验收 | 通过条件 |
|---|---|
| 权限感知 | Cortico 能区分在线、能力可用、访问拒绝、许可已生效和动作完成 |
| 真实反应 | 一次环境变化产生可关联的 Persona 决策和既有插件调用 |
| Coo 执行 | 新位置/表现由 Coo 原 renderer/body/tool 完成，有事实回执 |
| 重连恢复 | 重连后重新获得当前快照，不依赖漏掉的事件 |
| 单一决策中心 | Hub 没有第二个 Persona 决策，拒绝只返回事实 |
| 失败语义 | ASR 空结果、Provider 错误、动作失败和播放跳过不会被写成成功 |

完成判据：一条真实回合报告同时给出事件/请求/许可/结果关联；未满足前保持 `pending`。

## 7. 验收、证据、状态和回滚矩阵

| 模块 | 代码入口/接口 | 测试与运行证据 | 当前结论 | 回滚方式 |
|---|---|---|---|---|
| 协议 | `src/wire.rs`、`docs/protocol.md`、`/ws` | `cargo test`、schema 生成、协议报告 | accepted | 回退协议代码和生成 schema 同一提交 |
| Hub/Body | `src/bin/hub.rs`、`src/bin/body.rs`、`/state`、`/monitor.json` | 42 lib/12 body/23 hub；TTS/回执生产报告 | accepted（认证缺口） | 生产备份二进制，按 SHA256 回退 |
| Host 投影 | `tools/host-projection.mjs`、`/`、`/socket`、`/services` | `node --test tools/host-projection.test.mjs` 5/5；Host 报告 | 本机 accepted；第二设备 pending | 停止独立 Node 进程 |
| Coo World | `packages/cortico-world-absolute-solver/src/world.js`、`webUi()` | `npm test` 3/3、`npm pack --dry-run`、manifest 实测 | accepted（第二设备 pending） | Cortico 配置恢复备份或卸载包 |
| Coo TTS | `world:tts`、`tts.voice`、`audio-play`、`/api/coo/audio` | Coo TTS 接入报告、WAV 读取/播放 | accepted 本机 | 恢复 Coo World 配置备份 |
| ASR | Provider、`audio.up` | WAV/Hub 回合和 ASR 报告 | verified；实麦豁免 | 保持 WAV/Provider 路径，设备问题单独处理 |
| 阶段二 | `/host/connect`、Presence 接口及未来目标服务适配 | 尚无阶段二报告 | pending | 删除新增许可适配，不动现有插件 |
| 阶段三 | Body/Host 事实、Cortico World、既有插件 | 尚无自然关联回合 | pending | 停用环境事件适配，保留只读目录 |
| 安全与发布 | TLS 环境变量、部署脚本、凭据配置 | 尚无轮换/配对/连续性收束报告 | pending | 恢复旧配置仅限受控内网，禁止按旧文件名判断版本 |

现有证据至少包括：`cargo test` 42 lib/12 body/23 hub；`node --test tools/host-projection.test.mjs` 5/5；插件测试 3/3；Host 根页面、原生 WebSocket、Coo TTS WAV 播放；`D:\11\Logs\2026-10-28-host-projection-stage1.md`、`D:\11\Logs\2026-10-28-coo-tts-接入.md`、TTS 正式验收、段级回执、ASR 和流式阻塞报告。

## 8. 接手开发的推进顺序

1. 维护阶段一：第二台 LAN 设备打开根页面和 `/services`；补 HTTPS 证书信任和浏览器麦克风验收；补自然 Cortico 回合的关联 ID。
2. 阶段二：拆 Host 在线/能力声明、目标发现、一次许可、撤销/过期、断线和 trace 对账任务；先复用现有 Presence/Host 机制。
3. 阶段三：拆环境事实快照、权限已生效通知、Cortico 决策关联、既有插件结果和 Coo/Body 回执任务。
4. 安全收束：轮换历史凭据、确认 Hub 访问边界、完成 TLS/配对方案、解释 trace turn 41 → turn 18 的断点、改正构建文件版本命名。
5. 暂不推进流式 PCM、gRPC、机器人运动和独立面板，除非对应触发条件和验收目标已经出现。

每个阶段必须单独写任务卡和 `D:\11\Logs` 报告；通过后才进入下一阶段。只提交 Absolute Solver 仓库，不修改 Coo 安装目录源码；如需同步 npm，只发布插件版本且不带密钥、凭据、部署地址或私人日志。

## 9. 验证命令

在仓库根目录执行：

```powershell
cargo fmt --check
cargo test
cargo run --bin absolute-solver-protocol-schema -- schemas
git diff --exit-code -- schemas
node --test tools/host-projection.test.mjs
node --check tools/host-projection.mjs
node --check tools/host-projection-lib.mjs
node --check tools/coo-audio.js
Push-Location packages/cortico-world-absolute-solver
npm test
npm pack --dry-run
Pop-Location
git diff --check
git status --short
```

验证完成后应检查：总手册、索引、当前状态和阶段一任务卡的链接有效；计划没有把阶段二/三或流式 PCM 标记为完成；公开仓库不含 token、密码、完整上下文、私人日志或生产凭据。

## 10. 未决问题

- 第二台局域网设备、HTTPS 证书信任、浏览器麦克风和配对/认证尚未验收。
- Cortico paused 之外的自然输入→Persona→表达→TTS/Body 关联回合尚未形成生产证据。
- Hub 当前无中心认证、HTTP/WebSocket 未加密；历史 Presence token 和服务器密码是否已经轮换尚未核实。
- 生产 trace 从 turn 41 到 turn 18 的归档/替换关系尚未说明。
- 旧部署文件名带 `v0.2.1` 而 Cargo 代码是 `0.3.0`；必须按构建内容和 SHA256 回滚。
- Provider 流式 PCM 仍 blocked，不能作为阶段一能力。

该手册只描述当前可信边界；新的运行事实应先写入 `D:\11\Logs`，再回填本文件和 `REQUIREMENTS_INDEX.md`。 
