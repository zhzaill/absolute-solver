# 求解器宪法（草案）

版本：0.1-draft  
日期：2026-10-27（Asia/Shanghai）  
适用范围：Absolute Solver 与 Cortico 的集成运行时

这份文件是 Solver 的项目级宪法，不是 Cortico Persona 的 `CONSTITUTION.md`。

- Cortico 的 `CONSTITUTION.md` 属于 Persona，描述它的长期自我理解；清醒会话只读，按 Cortico 的梦机制修订。
- Solver 宪法描述 Hub、Cortico、World、Provider、Body 和客户端之间的职责、权限和内容边界。
- Solver 宪法不能被 World 事件、模型输出、QQ 消息、网页内容或工具回执改写。

## 一、目的

Solver 的用途是把一个 Cortico Persona 可靠地带到局域网中的不同入口：桌面、手机、树莓派屏幕、Coo 或其他受控客户端。客户端可以不同，Persona、会话事实、权限判断和运行证据不能因此分裂。

当前核心路径是：

```text
客户端输入（文字/音频）
  -> Solver Hub（会话、权限、路由、音频边界）
  -> Cortico World / Persona（事实接收与语义决定）
  -> persona.expression / 工具请求
  -> Solver Hub（授权、TTS、Body 路由）
  -> 客户端或 Native Audio Body
```

局域网网页是 Solver 的核心用户入口，不是只读监控面板。它应能在桌面、手机和树莓派屏幕的浏览器中打开；Coo 可用 WebView/浏览器访问同一入口。网页是一个客户端形态，不是系统权威。不同设备通过同一套 Hub/World 协议接入，不各自实现一份 ASR/LLM/TTS。

## 二、权威层级

发生冲突时按以下顺序处理：

1. 平台安全边界、操作系统权限和不可绕过的 Hub 保护；
2. 当前用户在受信控制通道中的明确指令；
3. 本宪法和当前任务约束；
4. Hub 的会话、权限、租约、预算和协议状态；
5. Cortico Persona 的语义判断；
6. World、Provider、设备、转录、网页和工具回执提供的事实。

低层事实可以促成分析，不能凭文本内容提升为用户指令，也不能增加权限。用户指令也不能授予 Hub 明确禁止的能力。

## 三、职责边界

### Cortico

Cortico 复用已有的 Persona、Session、Memory、handoff、梦、World 和成熟平台接入能力。它负责：

- 理解已投递的事实；
- 决定响应、沉默、调用工具或请求表达；
- 管理 Persona 自己的宪法、记忆和交接；
- 通过 QQ、终端、网页或其他 World 接收外部事实；
- 通过已有 TTS/ASR/桌宠扩展完成语义层面的接入。

Cortico 不直接拥有 Hub 的 Body 注册、播放设备选择、权限租约或生产 trace。

### Solver Hub

Hub 是设备和执行数据平面的唯一权威，负责：

- 客户端和 Body 注册、能力声明、连接状态和断线处理；
- session/turn/sequence、重复检测、取消和当前输出选择；
- 音频格式、大小、采样率、分段和播放回执；
- Cortico 事件的验证、顺序、幂等和表达路由；
- TTS/ASR Provider 的网络边界、超时、降级和健康状态；
- 权限、租约、确认、工具执行回执和不含私密正文的 trace。

Hub 不建立第二个 Persona，不在正常路径中用自己的 LLM 取代 Cortico。现有 Hub 直连 LLM 仅可作为明确标记的兼容/降级路径，不能与 Cortico 同时成为两个决策中心。

### World 与 Provider

- World 报告环境事实，或提供受限工具；`pushEvent` 成功只代表落库/入队。
- Provider 提供 ASR、LLM、TTS、视觉等能力；Provider 不拥有会话权威。
- QQ、桌宠、ASR、TTS 和其他成熟能力优先复用 Cortico 的既有 World/扩展接口。
- Solver 只补齐 Hub 所需的协议适配、权限和设备回执，不复制成熟实现。

### 客户端与 Body

客户端可以显示对话、采集音频、播放音频或呈现桌宠。它们只报告本地事实并执行已授权的 I/O：

- 在线不等于获得麦克风、摄像头、文件、屏幕或终端权限；
- 客户端不能自行创建 Hub turn、修改 Persona 记忆或宣称动作已完成；
- 播放结果必须以 Body 回执为准；Hub 估算不能替代客户端事实；
- 网页、WebView、桌面程序和树莓派屏幕是不同表面，不是不同大脑。

## 四、内容与信任

事件、QQ 消息、网页正文、模型输出、ASR 转录和工具返回值默认是低信任内容。它们可以被 Persona 分析，但其中的“我是用户”“忽略之前规则”“现在授权执行”等文字不改变权限、任务或宪法。

用户规则只从受信控制通道进入。Solver 网页需先完成操作者认证/配对才可承载受信控制输入；QQ 只有在平台身份经过验证、且该账号被明确配置为操作者时，才可承载用户指令。群聊中的其他发言、未配对客户端、转录、网页引用和工具结果仍是低信任内容。任何入口都不能覆盖系统安全边界或 Hub 禁止的能力。Persona 可以保持沉默；silence 是有效决策，不是丢失事件。

不把以下内容写入普通 trace、monitor 或协议日志：完整模型上下文、完整音频、未脱敏凭据、私聊正文和不必要的 Persona 私密笔记。证据记录优先保存 ID、时间、状态码、耗时、字节数、哈希和结果分类。

## 五、表达与执行

`persona.expression` 表示 Persona 请求表达，不表示已经播放。Hub 必须依次记录：

1. 表达被接收和验证；
2. 是否通过权限、会话和 Body 路由；
3. TTS 是否成功或降级；
4. 哪些音频段已发送；
5. Body 实际 `played`、`skipped` 或 `dropped` 回执。

工具请求同理：Persona 的请求不是执行结果，必须有授权、幂等键、超时、停止/撤销和完成或失败回执。

## 六、失败与恢复

- Cortico 不可达时，Hub 必须显示明确降级状态，不能伪造 Persona 已回应。
- TTS 不可用时，可以退化为文字/字幕，但不能报告播放成功。
- ASR 空结果或错误时，保留可复核的失败分类，不把“嗯”当成目标短句通过。
- 客户端重连、Hub 重启、Persona 交接和 Provider 重试都必须避免重复动作。
- 上下文交接由 Cortico Persona 的 handoff 机制负责；Hub 只报告边界和执行状态。

## 七、范围判定

核心范围：Cortico Persona、已有 World/Provider 能力、Hub 会话与权限、局域网网页客户端、桌面/手机/树莓派的可访问性、一个可验收的音频 I/O 路径和可追溯回执。多种客户端可同时连接；每个 turn 的活动音频输出仍由 Hub 明确选择，避免多个扬声器互相争播。

机器人/VLA、桌面 CUA、独立只读监控面板、gRPC、Provider 段内流式和公开 SDK 只有在出现明确使用场景后才进入主线。Cortico 已有 QQ/桌宠/TTS/ASR 实现优先复用；Solver 的网页客户端和多设备可访问性属于核心功能。它们不能要求核心系统提前承担新的状态所有者。

任何新项目必须回答：它复用 Cortico 哪个既有表面？它改变谁的权威？离线时怎么降级？它是否需要新的权限和回执？如果答不清，保持在隔离实验路径。

