# Absolute Solver 当前可信项目现状

更新时间：2026-10-28（Asia/Shanghai）
适用范围：仅 Absolute Solver 仓库、Hub/Body/Provider 运行链路及其验收证据。本文是日期快照，不代替源代码、实际运行结果和 `D:\11\Logs` 原始报告。

## 证据规则

当前代码、测试输出和实际运行记录优先；`D:\11\Logs` 保存验收证据；本文件只做摘要与索引。计划文档和状态措辞本身不能把功能改成 `accepted`。新证据应追加到日志并更新本手册，不覆盖历史结论。长期可复用的失败根因、架构决策和验证经验集中索引于 `docs/EXPERIENCE_LEDGER.md`。

## 系统与安全边界

Absolute Solver 是跨主机实时协作系统：Hub 编排回合、Body 路由和 Provider 调用；Body 连接真实设备并执行音频采集/播放；ASR、LLM、TTS 可独立部署。Hub 是逻辑协调点，但当前没有中心身份认证，局域网 WebSocket/HTTP 链路未加密。Presence token 只用于受限的 Presence 流程，不是 Hub 全局认证。

部署仅适用于可信局域网，不应直接暴露公网。历史日志曾出现 Presence token 和服务器密码，现已脱敏；凭据是否已轮换尚未核实。

## 仓库快照

- 仓库：公开源码仓库 `https://github.com/zhzaill/absolute-solver`，分支 `main`；生产运行仍限可信局域网。
- 应用版本：Cargo `0.3.0`；当前没有对外发布目标，也没有 `v0.3.0` Release。协作基线文档基于 `af63fad`。
- 生产 Body 验收基于 `df68252`；Cortico 协作基线则基于 `af63fad`，对应运行快照已按各自证据记录。
- 最新 CI 的格式、测试、schema 生成和 schema 差异检查全部通过；任务 A 的 Rust 测试为 42 个库、12 个 Body、23 个 Hub。

## 当前功能定位

Absolute Solver 的目标是：让同一个 Cortico Persona 通过局域网统一入口出现在浏览器、桌面、手机、树莓派和 Coo 上。局域网交互网页和多设备客户端协议是核心功能；Cortico 是 Persona/World/记忆与语义决策层，Hub 是设备会话、权限、音频路由和执行事实权威。源码现为公开仓库，生产系统仍是可信局域网内的私人部署。

独立运维监控面板、机器人/XuegerOS、VLA、桌面 CUA、Provider 流式 PCM、gRPC 和公开 SDK 都属于可选扩展或实验路线。Host 投影网页现已呈现 Cortico/Coo 服务、Coo 原 `/pet` 桌宠、Coo `desktop-pet` 原生对话流及 TTS/audio-play 状态；Hub `/app` 留作 Solver 原型/回退，不是 Coo 的对话入口。LAN 配对/认证和第二设备人工验收仍待完成。

## 运行快照

2026-10-27 已将任务 A 的 Hub 二进制部署至生产 Hub（LAN 地址从公开文档省略），并接入更新后的生产 Body。验收结束时 Hub 为 `0.3.0`、`idle`、turn 55，`body-production-audio` 在线。Hub SHA256 为 `5CAD35128BCB1FDAC944FE411452FAC025632DF87F65BB754A8D8332B57CF1C7`；Body SHA256 为 `3CA039E7A89CD4D8FAD125880DB3E278E4D7BE397754004CF0700AACFCF0AB03`。部署与回滚记录见本地 `D:\11\Logs\2026-10-27-tts-segment-receipts-production-deploy.md`。

生产 `/monitor.json` 已确认真实 Body 回执：正常分段 `turn=49` 为 2/2 播放并 complete；打断 `turn=54` 在 3 段送达 Body 后被 `turn=55` 打断，Body 回报 1 played、2 skipped/superseded，3/3 complete。验收结束时累计 `segments_played_body=4`、`segments_skipped_body=2`、`segments_dropped_body=0`、`segment_receipts=9`；详见 `D:\11\Logs\2026-10-27-tts-segment-receipts-body-production.md`。Hub 启动恢复发现 trace 第 49、104 行各有一条格式损坏记录，跳过并追加 `trace.recovered` 事件；原 trace 没有清洗或重写。

| Provider | 地址 | 最近证据 | 状态 |
|---|---|---|---|
| ASR | `127.0.0.1:9881` | HTTP 200；Qwen3-ASR CUDA；源 WAV 转写逐字正确 | Provider/WAV 路径 verified |
| LLM | `127.0.0.1:18081` | `/health` HTTP 200；`/props` 报告 `n_ctx=8192`；短英文指令返回 `PASS`（2 tokens / 706 ms） | 服务可用；0.6B 长上下文回答质量与显存竞争仍待稳定性验证 |
| TTS | `127.0.0.1:18080` | `/healthz` HTTP 200；upstream alive | 正式 TTS 验收通过 |

## 能力状态

| 能力 | 状态 | 证据 |
|---|---|---|
| WebSocket v1、ASV1 PCM16、未知 type 非致命兼容 | accepted | `docs/protocol.md`、`src/wire.rs`、schema 与协议测试；`D:\11\Logs\2026-10-26-protocol-unknown-type.md` |
| Native TTS、分段首段先播、打断、active handoff | accepted | `D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md`、`D:\11\Logs\2026-10-26-tts-segmented.md` |
| 120 秒整轮 TTS 预算 | accepted | `D:\11\Logs\2026-10-26-tts-turn-budget.md` |
| Trace 撕裂行恢复 | accepted | TTS 正式验收报告 §1.3、Rust 测试 |
| TTS 段级回执 | accepted；生产正常分段与 Body 队列打断均已实跑验收 | `D:\11\Logs\2026-10-27-tts-segment-receipts.md`、`D:\11\Logs\2026-10-27-tts-segment-receipts-production-deploy.md`、`D:\11\Logs\2026-10-27-tts-segment-receipts-body-production.md` |
| Cortico 协作边界 | 架构职责已明确；服务已恢复、运行调试中；生产量化未验收（尚无可关联的自然事件样本） | `docs/tasks/2026-10-27-cortico-collaboration-metrics.md`、`D:\11\Logs\2026-10-27-cortico-collaboration-baseline.md`、`D:\11\Logs\2026-10-27-cortico-runtime-debug.md` |
| Cortico 现有平台能力复用 | 已完成源码/运行边界核对；生产 QQ 已挂载但 NapCat 未连接、名单为空；Cortico ASR/VTuber 扩展未部署 | `docs/SOLVER_CONTENT_MAP.md`、`D:\11\Logs\2026-10-27-Solver-宪法与内容整理.md`、`D:\11\Logs\2026-10-27-Cortico启动与连接.md` |
| Solver 局域网交互网页 | 根入口直接代理 Coo 原 `/pet` 页面，原菜单、打字、语音输入、气泡、动作和 `/socket` 双向协议均由 Coo 保持；`/services` 只读显示健康目录，Host 浏览器已实测播放 Coo `tts.voice` 附件。LAN HTTP 不提供浏览器麦克风 API，需 HTTPS；第二设备、LAN 配对/认证仍待验收 | `tools/host-projection.mjs`、`tools/coo-audio.js`、`docs/tasks/2026-10-28-host-projection.md` |
| Coo TTS World 接入 | OpenAI 兼容合成、`tts.voice` 与 `audio-play` 已部署；真实音色合成有记录，操作者确认 TTS 整条链路正常。此前把 Hub TTS 探针用于判断 Coo 路径的方法不适用 | `D:\11\Logs\2026-10-28-coo-tts-接入.md`；Coo `worlds.tts` 与 `worlds.audio-play` 配置 |
| Provider 流式 PCM | blocked（已完成可行性测量） | `D:\11\Logs\2026-10-27-tts-streaming-pcm-可行性判定.md`；网关缓冲整段响应 |
| ASR Provider 与 WAV 回放 | verified | `D:\11\Logs\2026-10-26-asr-input-turn.md` |
| ASR 实麦通路 | accepted（任务制定者环境豁免，2026-10-26） | 完整音频经 Hub 回合、源 WAV 直连 Provider；`D:\11\Logs\2026-10-26-asr-input-turn.md`、`D:\11\Logs\2026-10-26-ASR实麦诊断与录音台.md` |

ASR 诊断结论：此前两次 Hub 实麦回合仅转写为“嗯”。本地默认耳机麦 Lenovo EH150P 为 16 kHz 单声道，但电平低且静音段占多数；内置 Realtek 阵列和两路虚拟麦在驱动层送全 0。声学回环中源 WAV 被逐字正确识别，同一音频的麦克风采集版本识别错误，故障定位到输入设备侧而非 ASR Provider/Hub。任务制定者因环境（耳机麦电平不足、平时不使用语音输入）免除实麦人工朗读条件；ASR 通过依据回到完整音频经 Hub 的 `audio.up` → ASR → LLM → TTS → Body 播放回合，以及源 WAV 直连 Provider 的逐字转写。设备选择、实时波形/频谱和录音台工具已实现，见 `absolute-solver-mic-probe`、`absolute-solver-mic-monitor`、`录音键.cmd`。

## 功能后续

- 2026-10-28 Host 投影阶段一：局域网入口 `http://192.168.1.178:18111/` 直接提供 Coo 原 `/pet` 页面；`/services` 提供独立服务健康目录。原页面的桌宠菜单、打字、语音输入、气泡和动作通过双向 `/socket` 实测，Coo 的 `tts.voice` 附件可经同源投影接口交给 LAN 浏览器播放。World `cortico-world-absolute-solver@0.2.1` 已发布并安装，使用 Cortico API 6 的 `webUi()` 显示投影网页和 `/services` 链接，环境提示包含使用说明；`/api/webui/manifest` 已实测确认。仍待第二设备及配对/认证验收；Cortico 当前 paused，未触发真实 Persona 回复。详见 `docs/tasks/2026-10-28-host-projection.md`、`docs/integrations/coo-render-contract.md`、`tools/HOST_PROJECTION.md` 与 `D:\11\Logs\2026-10-28-host-projection-stage1.md`。

这些项目是后续工作，不要与 Release 门槛混称为“唯一主任务”：

- 用 `录音键.cmd` 在可用设备上录制约 6 秒人工短句，逐字核对转写，作为可选 ASR 补证；当前不阻塞发布。
- 排查 Realtek 麦克风阵列送全 0（静音热键、Windows 输入电平、Realtek/Nahimic 驱动设置），或接入另一支可用麦克风。
- 恢复服务器远程开机：现场检查 BIOS/NIC 的 PCIe Wake-on-LAN 设置。
- 生产 Body 已接入并完成正常分段、打断回执验收；任务卡 `docs/tasks/2026-10-26-tts-segment-receipts.md` 的端到端范围已 accepted。生产 Body 是本机常驻客户端实例，Hub 仍运行在服务器计划任务中。
- Provider 侧流式 PCM 已测量但 blocked：直连 Provider 真流式，经网关变成整段缓冲；解除步骤见 `docs/tasks/2026-10-26-tts-streaming-pcm.md` 和可行性报告。
- Presence 覆盖层提前撤销仍待生命周期审计；机器人 Nav2/实体运动未验收。
- Cortico `v0.2.7` 计划任务当前运行，服务器本机 `127.0.0.1:7777/api/status` ready，`/api/log?level=error` 返回空数组；usage 账本原损坏行已留备份并清理。上下文设为 8192，Provider 配置现为 `maxTokens=256`、`temperature=0.2`；当前上下文计数曾达 7817/7936，显存 8108/8192 MiB，故没有增大 llama-server 上下文。生产协作延迟/覆盖率尚未测量；运行细节见 `D:\11\Logs\2026-10-27-cortico-runtime-debug.md`，后续按 `docs/tasks/2026-10-27-cortico-collaboration-metrics.md` 完成隔离标注样本测量。该测量服务于核心私有运行时，不构成对外平台发布门槛。
- Cortico `/api/worlds` 的只读快照显示 `solver=active`；`qq=active` 但连接状态为 error、监听名单为 0；`host` 当时显示 Hub 在线、0 个 Body。部署 `solver/config.json` 只覆盖 Solver World，默认 World 挂载由 Bot/Core 合并配置决定，不能单看部署 JSON 推断运行时启用状态。运行证据见 `D:\11\Logs\2026-10-27-Cortico启动与连接.md`。
- Cortico 管理 WebUI 只绑定服务器 loopback。它可以经受控隧道用于管理员维护，不能作为手机、Coo 或树莓派的 Solver 局域网交互入口。
- Cortico VTuber 扩展的 `outputTap` 捕获 Persona 演出工具流；TTS 合成可调用 HTTP 服务，字幕/动作经 SSE 推送，但 PCM 由 `DeviceAudioSink` 写 Cortico 主机声卡。扩展 SSE 不提供音频出口，因此未来复用桌宠声音时，Hub 必须接管 TTS 音频的设备路由和回执。源码审查基于本地只读缓存 `D:\11\Cache\cortico-world-vtuber-main`；生产未部署该扩展。
- Coo `cortico-world-desktop-pet@0.2.0` 默认配置是 `figure=whale`、`scheme=deepseek`（DeepSeek 大肥鱼）。当前 Coo `/pet` 服务页在本机端口 `7797`，根投影入口通过同源代理加载原 renderer、形象资源与桌宠运行时，并允许原生 `/socket` 双向交互；不再丢弃网页上行消息。真实动作控制、跨设备安全配对仍待验收。细节见 `docs/integrations/coo-render-contract.md` 和本地 `D:\11\Logs\2026-10-27-coo-render-contract.md`。

## 核心运行时收束项

ASR 实麦人工朗读条件已由任务制定者因环境免除；完整音频经 Hub 回合的历史证据已满足当前验收。当前不创建对外 Release；若要做内部版本标记或长期运行收束，仍需：

1. 轮换历史日志中出现过的 Presence token 与服务器账户凭据，验证旧凭据失效，并记录 Hub 实际网络访问边界；Hub 当前无中心认证且链路未加密。
2. 发布构建 `0.3.0`、SHA256、生产备份及回滚已在任务 A 部署中核验并实跑；但发布资产命名仍需改用与内容一致的版本名。历史活动路径带 `v0.2.1`，不能仅凭文件名识别版本。
3. 查明生产 turn 41 到 turn 18 之间是 trace 归档还是替换，建立新旧 trace 对应关系。

测试通过不等于运行证据齐全。上述事项不阻塞当前私有运行，但在创建内部版本标记前应补齐。

## 历史事实纠偏

- 线上协议是 WebSocket v1 + 二进制媒体；`docs/WIRE_PROTOCOL_V2.md` 是未采纳设计稿，以 `docs/protocol.md`、`src/wire.rs` 和生成 schema 为准。
- 生产 Hub 使用固定 LAN 地址；具体地址保留在操作者本地部署配置中，不进入公开仓库。
- 2026-10-23 turn 41 与 2026-10-26 turn 18 不能拼成连续生产序列，断点尚待 Release 阻塞项核实。
