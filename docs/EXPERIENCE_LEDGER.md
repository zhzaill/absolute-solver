# Absolute Solver 工程经验账本

日期：2026-10-27
状态：持续维护的经验索引，不代替源代码、验收报告或当前状态手册。
范围：仅 Absolute Solver 及其 Cortico 集成；其他项目仅在 Logs 已明确说明其 Solver 集成边界时引用。

这份账本回收既有 Logs、任务卡、协议和代码验收中仍有复用价值的决策、失败、根因、修复和验证方式。原始证据留在 `D:\11\Logs`，不删除、不改写成“始终如此”。遇到冲突时，当前代码和最新同范围实测优先；历史日志解释当时为何这么做。

## 1. 项目定位如何演进

早期目标已经包含一个连续 Persona、跨设备 Body、单一 Hub 权威、局部权限和一个活动音频输出；当时的分阶段计划把网页、ASR、TTS、记忆、多 Body、机器人都列入较宽路线。随后工程把 Hub、音频协议、Native Body 和部署证据做实。2026-10-27 再次校正范围：Absolute Solver 是让**同一个 Cortico Persona 可通过局域网入口出现在浏览器、Coo、桌面、手机和树莓派**的私人运行时。交互网页和多设备客户端是核心目标；机器人/VLA、gRPC、公开 SDK、独立运维面板不是当前核心交付。

本轮重新定下的组件责任：

| 所有者 | 长期职责 | 已有经验 |
|---|---|---|
| Cortico | Persona、Session、Memory、handoff、World、平台语义和 respond/tool/silence 决定 | 不要在 Hub 复制人格宪法、长期记忆或 QQ 历史；事件入队不等于 Persona 已处理 |
| Solver Hub | 客户端会话、turn、权限、Provider 编排、active Body、媒体路由、trace/monitor | 仓库仍有 Hub Memory 子系统/本地降级路径；它不应冒充 Cortico Persona 的 canonical long-term memory。接受 expression 不等于合成成功；合成成功不等于发到 Body；发到 Body 不等于播放 |
| Body / 客户端 | 本地采集、播放、渲染、断线事实和回执 | 不持有共享 Persona 或 Hub turn 权威；客户端连接在线不自动获得设备权限 |
| Provider / World | 提供能力或环境事实 | 失败、超时、降级和结果分类需由调用边界记录；普通事件不能提升为指令权限 |

## 2. 已验证的架构与协议经验

- **先固定状态所有者，再选传输技术。** 新接入只能映射到 Body、World、Provider 或 Tool Gateway；大型项目不能带入第二份 Persona、Hub 或权限状态。
- **保持单一 Persona 与单一活动音频输出。** 多设备可以同时在线、镜像字幕或显示状态；每回合由 Hub 选定一个活动扬声器，切换通过显式 handoff。身体迁移不是复制心智。
- **信号处理要靠近设备，语义决定归 Persona。** Body 可做 VAD、重采样、短缓冲和本地打断；Hub 做统一事件、去重、限流、能力协商和路由；Persona 不应收到未经整理的高频设备数据。
- **本地打断不等待网络。** 早期延迟分析曾把打断成本错误归给协议；可实现的低延迟静音必须先在 Body 本地执行，再通知 Hub 使旧 turn 失效。
- **Presence 不是 permission。** Host 在线、注册成功或收到 Persona presence 意图都不代表自动获准打开屏幕/麦克风/摄像头；Hub 的短时 scope/TTL grant 与 Host 本地策略都要通过，Host 可独立撤销。一次性票据、allowlist、设备在线核验和 revoke 需要有 trace。
- **视觉/机器人先做只读事实投影。** 相机流用内存中的 latest-frame 单槽、尺寸上限和陈旧帧 fail-closed，monitor 只收有界检测结果；原始帧/tensor 不进入 trace、Memory 或 Persona 上下文。CLI/SSH 脚本不能直接暴露给 Persona；运动只能经独立 Tool Gateway、短租约、限幅、watchdog、人工确认与硬件急停。
- **WebSocket v1 + PCM16 二进制帧是当前采纳协议。** REST 无法承担 Hub 主动下推；gRPC 虽有双向流能力，但当前跨语言客户端和版本维护成本尚未触发迁移条件。二进制媒体解决 JSON/base64 膨胀，旧 Body 可继续使用兼容路径。`WIRE_PROTOCOL_V2.md` 是未采纳方案，不能当作线上协议。
- **可选协议增量优先向后兼容。** `seg_total`、`last` 等可选字段在 v1 中扩展；未知 `type` 非致命并保持连接，已知 type 字段非法与未知 type 应区分。schema 必须由 generator 重生成并做差异检查。
- **排查必须拿原始字节或真实运行现象。** 配置、HTTP 状态和设备名不是端到端成功证据；确认内容要看 WAV 头/PCM 参数/回执，需要时查看字节、源日志或实际听感，而不是继续从文件名推断。

## 3. TTS：从一段音频到真实播放事实

### 已建立的能力

- Provider WAV 可由 Hub 解码为 PCM16，通过二进制 `say.audio` 发给 active Native Audio Body；已在真实扬声器听音确认。
- 正式链路分别记录 Provider 生成、Hub 解码/发送、Body 收到、播放器实际结果；无 active Body 时允许合成成功但明确记未投递，不得报告播放成功。
- 分段 TTS 采用文本边界切分、有界并发、按 seq 顺序播放、超时/失败字幕降级。已有真实验收显示首段先播显著早于整段等待，段间播放连续。
- 120 秒默认整轮预算曾在慢 Provider 实跑触发；该预算在某段返回时检查，并非独立定时器。Provider 永不返回时靠单段 timeout，不可把两种时限混为一谈。
- Body 段级回执已生产验收。Hub 估算的 dropped 与 Body 报告的 played/skipped 可能不同；只有 Body 视角能陈述实际播放事实。回执仅观测，不控制回合；重复回执需幂等。
- Trace 撕裂行恢复已实现：保留原坏行、跳过不可解析记录、追加恢复事件；不静默清洗历史证据。

### 失败经验与有效验证

| 发现 | 根因/修复 | 以后怎样验证 |
|---|---|---|
| 立体声设备播放成 2 倍速 | 把交错 PCM 声道槽位当作单声道帧消费；修复为按帧消费并复制到输出声道 | 必须真实听音；播放器按标称 PCM 时长计算的 timer 可能仍然“正确” |
| 打断后缓冲音频继续播 | 只清空待处理 map，已交给播放线程的块不受影响；播放器逐块校验 latest turn 并跳过过期回合 | 在真实播放期间打断，逐 turn/seq 核对 skipped；当前正在播放段仍可能播完 |
| 一次性 Body 播完第一段就退出 | 退出条件没有贯穿最后段标记；现在 `say.last` 一路传至播放事件，最后一段播放完成后才退出 | 多段 WAV 回放/实麦路径核对每段均收到且回执发完 |
| Hub `segments_dropped` 与 Body 实际 skipped 不同 | Hub 只根据名义时长估算，无法知道播放线程已经接收了哪些段 | 对同一 turn 按 seq 对账 Hub sent 与 Body receipt，不要用累计 monitor 数替代逐回合数据 |
| 上游支持流式但网关返回整段 | 网关用非流式 `requests.post` 收完整响应再一次性构造 Response | 记录首块、总时长、块分布；HTTP 200 或多个 TCP chunks 不能单独证明真流式 |

### TTS 不可混淆的几种能力

| 能力 | 实际含义 | Solver 状态 |
|---|---|---|
| 整段 WAV | 每个请求完整合成一段 | 已验收 |
| 文本分段 | 长文拆成多次完整 WAV 请求，首段可先播 | 已验收 |
| PCM 真流式 | 同一段生成期间，首块先于整段完成到达 Hub | 上游直连可行；经生产网关 blocked，需授权修网关后再做 Hub/Body |
| Body 段级回执 | 播放事实回报 Hub | 已验收并部署 |

## 4. ASR：Provider、Hub 回放和实麦必须分层

- 曾有两次实麦回合只识别成“嗯”。设备诊断用 RMS、峰值、静音采样比例和声谱比较，把失败定位到输入设备信号，不是先怪 ASR 服务或采样率。
- 默认耳机麦为 16 kHz 单声道，但电平很低；Realtek 阵列与虚拟麦送全 0。16 kHz 本身不是根因。提高系统音量后，同一语音回环采集仍弱于源 WAV，识别内容错误。
- 同一已知文本的源 WAV 直连 Provider 可逐字识别；随后完整 WAV 经 Hub 的 `audio.up → ASR → LLM → TTS → Body` 两轮也逐字通过。用户随后明确豁免实麦朗读条件，所以 ASR 任务按该替代口径 accepted；**这不等同于实麦通过，也不等同于浏览器麦克风已验收**。
- 一项链路状态至少拆成：Provider ready、已知 WAV 转写、Hub 回合、真实设备采集、目标语句逐字正确。任何上游层通过都不能替代更下游层。
- 服务器休眠后，SSH 可达不代表服务已恢复；一次唤醒后六个计划任务全在 Ready。ASR CUDA 冷启动约 140 秒，TTS 首次请求约 33 秒，健康检查应等服务和上游实际 ready，不能只等端口。
- 诊断录音必须走与 Body 相同的采集 API；浏览器录音仅可作辅助观察。设备名/序号要可选，低电平需告警，不得把近静音结果静默解释成“识别成功”。

## 5. Cortico 的复用方式与接口边界

- Cortico 通过 Bot 装配 Persona 与 World；World `pushEvent` 的 envelope 只证明落库/排队，不证明 Persona 看见、决策或回应。沉默是合法结果。
- Cortico QQ 是 OneBot World，具备监听名单、平台身份、历史、图片/语音和起草-确认门。生产日志中 `qq=active` 仅表示已挂载；连接错误和空名单意味着通道不可用。
- Cortico WebUI 是管理控制台。已核对生产仅监听 `127.0.0.1:7777`，可经受控隧道维护，不能替代 Solver LAN 交互网页。
- Cortico VTuber 扩展的 `outputTap` 捕获 Persona 的 `vtuber_act` 输出，TTS 经 HTTP 合成，VTube Studio 接收动作，字幕/动作状态走 SSE/Overlay，弹幕另有 WebSocket。其 PCM 由 Cortico 主机 `DeviceAudioSink` 播放；SSE 不运音频，没有远端 Body 播放与 Hub receipt。
- 因此复用顺序应是 Persona、Session/Memory、QQ/World、演出语义和合成能力；如接入桌宠声音，必须把 PCM 送入 Hub 的选定 Body 并拿到 Body 回执，禁止与 Cortico 主机声卡并行出声。
- 生产协作测量必须区分 World 接收、Persona 决策、`persona.expression` 接受、TTS、Body receipt。需要共享 correlation ID；跨进程延迟要考虑时钟偏差。不能把历史上 Hub 直接注入 expression 的 TTS 验收说成 Cortico 已作出 Persona 决策。

## 6. 部署、恢复和安全经验

- 生产文件名会漂移：名为 `v0.2.1` 的二进制实际运行 `0.3.0`。部署、回滚都要核验 `/state` 版本与 SHA256；文件名不能作为版本依据。
- 部署健康检查要连真实 bind 地址。曾两次因错误检查 `127.0.0.1:18100` 回滚；修正为服务实际绑定的地址后部署成功。部署脚本要把 bind、health probe、任务状态写成显式参数/记录。
- 生产变更先在隔离端口和 trace 副本启动，检查状态恢复和新 monitor 字段；再备份、切换、重启、核 SHA256/state，最后用生产客户端实测。失败时验证回滚后的服务健康；避免用生产 trace 做故障注入。
- 多服务服务器从休眠恢复需按依赖启动并逐项 health check；计划任务 `Ready` 不等于服务运行。冷启动模型加载时间必须纳入可用性观察。
- Cortico 与 ComfyUI 曾发生同机进程中断关联，但具体机制未定；不能将同时发生写成已证明显存根因。需记录进程状态、GPU、任务调度和退出日志再判因。
- SSH 非交互需固定并核验 host key；缺少 `-hostkey` 时 `-batch` 会等待/失败，不能用向 stdin 管道写 `y` 绕过信任校验。
- Hub 当前无全局身份认证，LAN HTTP/WS 未加密；Presence token 不等于 Hub 鉴权。可信局域网是当前部署边界，不能公网暴露。历史日志曾含明文 token/口令，后来做了脱敏，但凭据是否轮换必须单独核实，脱敏不代表失效。
- 诊断 WAV 只允许显式指定且限于 `D:\11\Logs\tts\`；音频正文不应进入仓库、普通 trace、monitor 或任务卡。trace 保存 ID、耗时、状态和哈希等必要事实。

## 7. 证据方法与状态纪律

1. 在跑测试前明确问题、分母、成功条件、错误分类、运行产物位置和回滚路径；无分母的“成功率”没有解释力。
2. 先隔离测试进程、端口、trace、数据库和 Provider；不把 mock、旧 Body、listen-only 或浏览器演示冒充生产扬声器证据。
3. 报告同时给原始数字和结论，例如首块与总时长、Hub sent 与 Body receipt、真实播放与播放器耗时；单报 HTTP 200 或测试计数不够。
4. `accepted` 只对任务卡明示范围有效；任务的已知边界仍需保留。后续证据关闭前文边界时，必须回填索引和当前状态。
5. 实验失败也要归档：网关假流式、无信号麦克风、无 Body、trace 撕裂和部署探针错误都推动了设计收敛。
6. 状态词要区分 `accepted`、`verified`、`blocked`、`not implemented`、`not measured`。服务 ready、World active、HTTP 202、Provider 返回 WAV、say 已发送是不同事实。
7. 历史 turn、配置和进程是时间快照；当新日志或代码替代它们时，保留原记录并在本手册标注“当时”。生产 trace 从 turn 41 到 turn 18 的断点仍未解释，不能拼接成连续历史。

### 借鉴来源中的经验

以下是 Amadeus、DSH 和 Cortico VTuber 的工程观察，作为 Solver 的验证/集成经验引用，不表示它们属于 Solver，也不表示将其源码并入：

- **TTS 至少有三个正交验收门：信号完整性、内容保真、音色身份。** 峰值/RMS/频谱正常不能证明说对了内容；固定 seed 下字节哈希也可能因 GPU 浮点差异变化。应使用预先指定的代表句、正确语言参数，并将合成音频送 ASR 与输入文本比对；还需独立听音/音色检查。
- **测试输入要能证伪当前假设。** 曾用中文输入验证只在生产日文失败的配置，因此测试“吻合”了缺陷假设而漏检。每类关键参数至少有生产语言/边界/反例样本。
- **配置层不能承载的语义要明确补偿。** OpenAI speech 请求缺少语言字段时，接收网关曾按文本推断语言并保留显式关闭项。对 Solver 的教训是协议字段缺失需明确归属、推断范围、退出开关和验收样本，不要把隐式默认伪装成客户端声明。
- **复用 UI 框架扩展点，避免 DOM 猜测。** DSH TTS 浏览器播放从 MutationObserver/DOM 扫描改为官方 `tool.call.toolview` 扩展点；对 Solver 的网页客户端也应寻找 Cortico/宿主正式契约，不依赖脆弱的页面结构推断。
- **实际验证用户路径，别绕开启动入口。** `.cmd` 文件曾因 LF 而在 Windows `cmd.exe` 把注释碎片当命令；直接用 Node 运行绕过了失败路径。Solver 的部署脚本、Body 启动器和浏览器录音键都应按操作者实际入口实跑。
- **检查语义应用结构化解析，而非文本包含。** DSH 预设校验曾只看顶层插件、漏掉分组内成员；字符串包含也被注释中的插件名骗过。配置有 parser/schema 时就用它，并递归检查嵌套内容。
- **网络可达、扩展可加载、播放器有音频，都是不同层级。** Cortico 桌宠可在一台机器本地出声，但无远端音频出口；DSH 工具卡浏览器可播 WAV 也不等于 Hub active Body 播放。验收报告需标出实际终点和所有未经过的边界。
- **借鉴结构，不复制实现。** Amadeus 对播放序号、epoch 打断、有界并发和延迟埋点的经验曾被用于设计比较；外部代码的许可、依赖、运行拓扑和用户场景另行审查。没有许可与兼容核对前不复制代码。

## 8. 经验与主证据索引

### 架构、范围与协议

- 早期完整架构与所有权：[2026-10-20-Absolute-Solver-完整方案.md](D:/11/Logs/2026-10-20-Absolute-Solver-完整方案.md)
- 跨设备“串门”与瘦 Body：[2026-10-21-Absolute-Solver-感知入口与跨设备串门.md](D:/11/Logs/2026-10-21-Absolute-Solver-感知入口与跨设备串门.md)
- 大型项目接入过滤器：[2026-10-22-Absolute-Solver-大型项目接入前的策略锚点.md](D:/11/Logs/2026-10-22-Absolute-Solver-大型项目接入前的策略锚点.md)
- 二进制媒体实作：[2026-10-22-Absolute-Solver-二进制媒体面.md](D:/11/Logs/2026-10-22-Absolute-Solver-二进制媒体面.md)
- WebSocket vs REST/gRPC 的最终决策（方案文档有未采纳部分，线上以当前协议为准）：[2026-10-23-协议优化最终方案.md](D:/11/Logs/2026-10-23-协议优化最终方案.md)
- 权威状态纠偏汇总：[2026-10-26-absolute-solver-acceptance-reconcile.md](D:/11/Logs/2026-10-26-absolute-solver-acceptance-reconcile.md)
- 早期架构问题分析（保留历史问题，不代表当前状态）：[2026-10-24-Absolute-Solver-项目分析.md](D:/11/Logs/2026-10-24-Absolute-Solver-项目分析.md)
- 协议契约：[protocol.md](protocol.md)、`src/wire.rs`、`schemas/`

### Provider、音频与 TTS

- 正式 TTS/Body/故障/恢复：[2026-10-26-Absolute-Solver-TTS正式验收.md](D:/11/Logs/2026-10-26-Absolute-Solver-TTS正式验收.md)
- 分段与播放真实缺陷：[2026-10-26-tts-segmented.md](D:/11/Logs/2026-10-26-tts-segmented.md)
- 整轮预算：[2026-10-26-tts-turn-budget.md](D:/11/Logs/2026-10-26-tts-turn-budget.md)
- 输出边界、诊断音频和落盘守卫：[2026-10-26-tts-output-boundaries.md](D:/11/Logs/2026-10-26-tts-output-boundaries.md)
- Body receipt 协议与幂等：[2026-10-27-tts-segment-receipts.md](D:/11/Logs/2026-10-27-tts-segment-receipts.md)
- 生产 Hub 部署：[2026-10-27-tts-segment-receipts-production-deploy.md](D:/11/Logs/2026-10-27-tts-segment-receipts-production-deploy.md)
- 生产 Body 正常/打断验收：[2026-10-27-tts-segment-receipts-body-production.md](D:/11/Logs/2026-10-27-tts-segment-receipts-body-production.md)
- 流式阻塞测量：[2026-10-27-tts-streaming-pcm-可行性判定.md](D:/11/Logs/2026-10-27-tts-streaming-pcm-可行性判定.md)

### ASR 与运行调试

- 实麦失败根因、电平测量和录音工具：[2026-10-26-ASR实麦诊断与录音台.md](D:/11/Logs/2026-10-26-ASR实麦诊断与录音台.md)
- 完整音频经 Hub 的替代验收：[2026-10-27-ASR导通复验.md](D:/11/Logs/2026-10-27-ASR导通复验.md)
- Cortico 启动、Hub 连接和 QQ 当前挂载但不可用：[2026-10-27-Cortico启动与连接.md](D:/11/Logs/2026-10-27-Cortico启动与连接.md)
- Cortico/LLM 服务账本与上下文限制：[2026-10-27-cortico-runtime-debug.md](D:/11/Logs/2026-10-27-cortico-runtime-debug.md)
- 责任边界与协作测量缺口：[2026-10-27-cortico-collaboration-baseline.md](D:/11/Logs/2026-10-27-cortico-collaboration-baseline.md)
- Cortico 实现核对与 Solver 当前定位：[2026-10-27-Solver-宪法与内容整理.md](D:/11/Logs/2026-10-27-Solver-宪法与内容整理.md)

### Presence、机器人和安全

- Presence 历史部署（凭据已脱敏，轮换仍需独立验证）：[2026-10-23-Absolute-Solver-服务器部署presence.md](D:/11/Logs/2026-10-23-Absolute-Solver-服务器部署presence.md)
- Presence/Host/只读视觉的本地实现与验证（不是生产往返验收）：[2026-10-23-Absolute-Solver-工作日志.md](D:/11/Logs/2026-10-23-Absolute-Solver-工作日志.md)
- XuegerOS 只读接入与运动安全审计：[2026-10-22-Absolute-Solver-XuegerOS接入审计.md](D:/11/Logs/2026-10-22-Absolute-Solver-XuegerOS接入审计.md)
- 项目定位与早期架构分析（当时曾将 Hub Memory 列为 Hub 权威；长期 Persona Memory 现归 Cortico）：[2026-10-24-Absolute-Solver-项目分析.md](D:/11/Logs/2026-10-24-Absolute-Solver-项目分析.md)
- Amadeus TTS 语言缺参、错误匹配测试输入与三道正交验收门：[2026-10-16-Amadeus-TTS适应能力专题.md](D:/11/Logs/2026-10-16-Amadeus-TTS适应能力专题.md)
- ASR 麦克风设备实例选择与“能采到”不代表信号可识别：[2026-10-16-Amadeus整体运行-桌面本地模型服务器.md](D:/11/Logs/2026-10-16-Amadeus整体运行-桌面本地模型服务器.md)
- DSH 插件语义校验、外部契约和用户真实启动路径：[2026-10-16-DSH-TTS插件.md](D:/11/Logs/2026-10-16-DSH-TTS插件.md)
- DSH 工具卡浏览器音频与 Hub Body 边界：[2026-10-25-DSH-TTS端点修复.md](D:/11/Logs/2026-10-25-DSH-TTS端点修复.md)
- Cortico VTuber 跨屏网络边界的历史源码审计（其中的 IP/服务部署方案已过期，本文只借用接口边界结论）：[2026-10-19-cortico-vtuber-跨屏部署计划.md](D:/11/Logs/2026-10-19-cortico-vtuber-跨屏部署计划.md)
- 多项目状态与部署历史快照（只作历史参考）：[2026-10-25-Absolute-Solver-总项目报告-v2.md](D:/11/Logs/2026-10-25-Absolute-Solver-总项目报告-v2.md)
- 当前状态历史快照：[2026-10-26-Absolute-Solver-当前可信状态.md](D:/11/Logs/2026-10-26-Absolute-Solver-当前可信状态.md)
- 当前权威状态和未决项：[ABSOLUTE_SOLVER_CURRENT_STATE.md](ABSOLUTE_SOLVER_CURRENT_STATE.md)

## 9. 仍待继续的经验闭环

- LAN 交互网页尚未实现；首条产品纵切需包含操作者认证/配对，不可把“局域网可达”当作信任。
- 生产 Cortico 自然输入→Persona 决策→expression→Hub→Body 尚缺共享因果 ID 的验收样本；现有历史直注 expression 不能替代它。
- Cortico 桌宠音频若复用，需设计从合成到 Hub active Body 的适配，避免绕过 Hub 的本机声卡播放。
- Provider 流式 PCM 等网关端到端传输打通和授权后再解除 blocked。
- 历史凭据轮换、Hub 网络边界、生产 trace 连续性断点仍未完全闭环。
- QQ World 当前 active 但 NapCat 连接错误且 roster 为空；需先决定是否恢复 QQ 入口，再做身份和发送确认验收。
- 老计划中关于 Pi 型号、Live2D 渲染、VLA/机器人和多 Body 的试验结论保留为背景；是否回到主线要由当前明确设备需求和验收条件决定。
