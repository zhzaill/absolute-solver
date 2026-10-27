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
4. **扩展层**：桌宠、ASR、TTS、VTuber 等已存在的 Cortico 扩展优先复用；先区分语义、合成和输出边界，再通过明确适配器连接。Solver 不复制 Persona 决策、模型调用和演出语义，但必须接管多设备音频路由与播放回执。
5. **客户端层**：网页、Coo、桌面、手机和树莓派都是 Hub 客户端/Body。它们共享协议和权限，但不共享本地会话主状态。

## 能力与当前部署的区别

“Cortico 已有实现”不等于“Absolute Solver 当前生产部署已启用”：

| 能力 | Cortico 中的现有形式 | Absolute Solver 当前证据 | 当前结论 |
|---|---|---|---|
| Persona/Session/Memory/handoff/梦 | Cortico Bot 与 Core 契约 | 生产 Cortico v0.2.7 `/api/status` ready；Hub 与 Solver World 曾确认连通 | Persona 是目标决策者；当前仍缺有因果关联的自然输入→决策→表达→Body 样本 |
| Solver World | Cortico `solver` World，Bearer token 到 Hub | 生产 `worlds.solver.enabled=true`，Hub `18100` 可达；Cortico WebUI 只绑定 `127.0.0.1:7777` | 已部署；该 World 是桥接通道，不是 LAN 用户网页 |
| QQ | 内建 `qq` World，名单、历史、图片/语音和起草确认门 | 生产 `/api/worlds` 显示 `qq=active`，但连接灯为 error、名单 0；NapCat `127.0.0.1:3001` 未配置/不可用 | 已挂载但通道未接通；不是当前可用入口。重新启用前须确认身份名单与发送确认门 |
| 桌宠/VTuber TTS | `cortico-world-vtuber`：`outputTap` 捕获 `vtuber_act`、流式/整段合成、VTS 动作、字幕/动作 SSE、`DeviceAudioSink` | 生产未安装/启用该扩展；Cortico TTS 扩展的声卡路径与 Solver Provider `18080`→Native Body 是两条不同路径 | 可复用 Persona 演出语义和 TTS 能力；音频需适配到 Hub，扩展默认本机播放且 SSE 不传音频，不能绕过 active Body |
| Cortico ASR | `cortico-world-asr` 扩展，RtAudio、能量门限切分、FireRedASR2-AED（以扩展文档为准） | 生产未挂载；当前经 Hub 的 ASR 来自 Solver Provider `9881`，完整 WAV/回放链已有证据 | 可复用；与 Solver Body 麦克风输入尚未形成同一条生产采集链 |
| Coo/其他客户端 | WebView/浏览器访问 Solver 的统一客户端协议 | 尚无 Coo→Solver 完整运行验收；当前没有 LAN 交互网页 | 目标核心形态，未实现/未验收 |

## 一次完整回合的内容流

```text
QQ / Coo / 浏览器 / 树莓派输入
  -> 对应 Cortico World 或 Solver Client 适配器
  -> Persona 读取事件、宪法和 Memory
  -> respond / tool / silence
  -> persona.expression 或 tool request
  -> Solver Hub 校验、授权、分配 turn
  -> Solver Hub 选择 Cortico TTS 合成适配器或现有 Provider，并指定 active Body
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

