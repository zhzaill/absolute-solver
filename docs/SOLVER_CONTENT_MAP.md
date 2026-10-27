# 求解器内容整理表

版本：0.1-draft  
日期：2026-10-27（Asia/Shanghai）

目标：让 Solver 与 Cortico 的成熟机制各自保有自己的内容，不把同一份规则、记忆、事实和证据复制到多个地方。

## 内容归属

| 内容 | 唯一归属 | 进入谁的上下文 | 是否可被普通事件改写 | 备注 |
|---|---|---|---|---|
| 平台安全和权限 | 操作系统、Hub 配置与权限代码 | Hub/客户端执行层 | 否 | 不是 Persona 文案 |
| Solver 宪法 | `docs/SOLVER_CONSTITUTION.md`；部署时以受控配置注入 | Hub 与 Cortico Solver World | 否 | 项目级边界，不等于 Persona 宪法 |
| Cortico 宪法 | Cortico 部署的 `CONSTITUTION.md` | Persona system prefix | 仅按 Cortico 梦机制修订 | 由 Persona 自己维护 |
| Persona 长期记忆 | Cortico `MEMORY 0–4`、`WORLDVIEW.md`、`people/`、`memo/` | Cortico Persona | 按 Persona 写权限 | 不复制到 Hub SQLite |
| QQ/桌宠/其他平台事实 | Cortico 对应 World 事件库 | Persona 事件投递 | 事件正文不能升权 | QQ 的起草确认门仍由 QQ World 保持 |
| Solver 设备事实 | Hub monitor、Body trace、客户端本地记录 | Hub/客户端 | 不改写 Persona 规则 | 连接、能力、播放和采集结果 |
| 用户当前指令 | 受信控制通道 | 当前 session/turn | 只由更高层用户指令替换 | 网页正文和 QQ 正文不能冒充 |
| Persona 表达 | `persona.expression` 事件 | Hub 执行层 | 不等于播放结果 | 必须追踪到 TTS/Body 回执 |
| Provider 结果 | Provider 回执与耗时计量 | 发起它的层 | 不能成为权限 | ASR/LLM/TTS 只提供能力 |
| 运行证据 | `D:\11\Logs` 与 Hub trace | 人类复盘/监视 | 追加，不覆盖历史 | 记录摘要，不落完整私密正文 |
| 架构和验收状态 | `docs/` | 工程协作 | 不能被“已完成”文字单独改状态 | 必须引用 Logs 证据 |

## Cortico 接入形式

Cortico 已有能力按以下方式接入 Solver：

1. **Persona 层**：沿用 `corti-soulmate`/其他 Bot 的 Persona、Session、Memory、handoff 和梦机制；Solver 不另造人格记忆。
2. **World 层**：Solver 作为 Cortico World/外部事实入口，使用 `pushEvent`、触发策略、事件库和工具回执；事件入队不等同于 Persona 已处理。
3. **平台层**：QQ World 保留监听名单、会话标签、历史查询、图片/语音和起草-确认门；Solver 只接收经验证的 Persona 表达或工具结果。
4. **扩展层**：桌宠、ASR、TTS、VTuber 等已存在的 Cortico 扩展优先直接挂载或通过明确适配器连接；Solver 不复制其模型调用和演出逻辑。
5. **客户端层**：网页、Coo、桌面、手机和树莓派都是 Hub 客户端/Body。它们共享协议和权限，但不共享本地会话主状态。

## 能力与当前部署的区别

“Cortico 已有实现”不等于“Absolute Solver 当前生产部署已启用”：

| 能力 | Cortico 中的现有形式 | Absolute Solver 当前证据 | 当前结论 |
|---|---|---|---|
| Persona/Session/Memory/handoff/梦 | `corti-soulmate`、`cormini` 等 Bot 与 Core 契约 | 服务器 Cortico v0.2.7 的 `solver` 部署在线 | 已作为集成基础；具体 Persona 决策闭环仍待关联样本 |
| Solver World | Cortico `solver` World，受 Bearer token 保护，向 Hub 回送 `persona.expression` | `worlds.solver.enabled=true`，Hub `18100` 可达 | 已部署 |
| QQ | 内建 `qq` World，名单、历史、图片/语音和起草确认门 | 当前 Solver 部署配置只列 `solver` World，未启用 QQ | 可复用，未作为当前生产入口 |
| 桌宠/VTuber TTS | `cortico-world-vtuber` 扩展，包含演出、声卡 TTS、字幕/流 | 当前部署 `extensions/` 为空；TTS 证据来自 Solver Provider `18080` 与 Native Body | 可复用，未作为当前 Solver TTS 实现 |
| Cortico ASR | `cortico-world-asr` 扩展，RtAudio、端点切分和 FireRedASR2-AED | 当前部署未挂载该扩展；ASR 证据来自 Solver Provider `9881` | 可复用，未作为当前生产采集链 |
| Coo/其他客户端 | 外部客户端或 WebView 访问 Hub/World 协议 | 尚无 Coo→Solver 的完整运行验收 | 目标形态，不能写成已完成 |

## 一次完整回合的内容流

```text
QQ / Coo / 浏览器 / 树莓派输入
  -> Cortico World 或 Solver Client 事件
  -> Persona 读取事件、宪法和 Memory
  -> respond / tool / silence
  -> persona.expression 或 tool request
  -> Solver Hub 校验、授权、分配 turn
  -> Cortico TTS/ASR 扩展或 Solver Provider 适配器
  -> 选定客户端/Body 执行
  -> receipt / trace / monitor
```

这条流里每个箭头的含义不同：事件入队、Persona 决策、Hub 接收、TTS 成功和 Body 播放不能合并成一个“成功”。

## 不应重复的内容

- 不在 Hub 再写一份 QQ 会话历史；QQ World 已有自己的平台身份、名单、历史和确认门。
- 不在 Hub 再维护一份 Persona 宪法和长期记忆；Hub 只保留执行所需的 ID、状态和证据摘要。
- 不让 Hub 直连第二个 LLM 作为常规 Persona；需要降级时明确标注为 `hub-llm-degraded`。
- 不让每个 Body 保存自己的 turn、身份和“已播放”推断；Hub 管回合，Body 报事实。
- 不把 TTS/ASR 的完整音频放入普通 trace、Cortico 事件正文或仓库。
- 不把网页界面当作权限系统；网页只是客户端表面，权限和租约由 Hub/Host policy 决定。

## 第一阶段内容整理顺序

1. 用 Solver 宪法固定边界和优先级。
2. 用 Solver World 接入 Cortico 事件和 `persona.expression`，记录 `correlation_id`。
3. 把 Hub 的用户交互入口定义为客户端协议，网页只是首个实现。
4. 让 Coo、浏览器、手机和树莓派复用同一客户端协议，不分别实现 ASR/LLM/TTS。
5. 用一条可复核回合验收“输入 → Persona 决策 → 表达 → TTS → Body 回执”。
6. 在这条链稳定前，不扩展机器人、VLA、gRPC 或第二套记忆系统。

