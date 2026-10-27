# Absolute Solver 当前可信项目现状

更新时间：2026-10-27（Asia/Shanghai）
适用范围：仅 Absolute Solver 仓库、Hub/Body/Provider 运行链路及其验收证据。本文是日期快照，不代替源代码、实际运行结果和 `D:\11\Logs` 原始报告。

## 证据规则

当前代码、测试输出和实际运行记录优先；`D:\11\Logs` 保存验收证据；本文件只做摘要与索引。计划文档和状态措辞本身不能把功能改成 `accepted`。新证据应追加到日志并更新本手册，不覆盖历史结论。

## 系统与安全边界

Absolute Solver 是跨主机实时协作系统：Hub 编排回合、Body 路由和 Provider 调用；Body 连接真实设备并执行音频采集/播放；ASR、LLM、TTS 可独立部署。Hub 是逻辑协调点，但当前没有中心身份认证，局域网 WebSocket/HTTP 链路未加密。Presence token 只用于受限的 Presence 流程，不是 Hub 全局认证。

部署仅适用于可信局域网，不应直接暴露公网。历史日志曾出现 Presence token 和服务器密码，现已脱敏；凭据是否已轮换尚未核实。

## 仓库快照

- 仓库：`https://github.com/zhzaill/absolute-solver`，分支 `main`。
- 应用版本：Cargo `0.3.0`；GitHub 尚无 `v0.3.0` tag/Release。当前工作树快照提交为 `63f3c2b`。
- 本地 `main` 与 `origin/main` 同步到 `63f3c2b`；工作区干净。
- 最新 CI 的格式、测试、schema 生成和 schema 差异检查全部通过；任务 A 的 Rust 测试为 42 个库、12 个 Body、23 个 Hub。

## 运行快照

2026-10-27 已将任务 A 的 Hub 二进制部署至 `LAN_HUB_ADDRESS:18100`。当前版本 `0.3.0`、状态 `idle`、turn 48、无 active Body。生产进程 SHA256 为 `5CAD35128BCB1FDAC944FE411452FAC025632DF87F65BB754A8D8332B57CF1C7`，旧版备份及回滚记录见 `D:\11\Logs\2026-10-27-tts-segment-receipts-production-deploy.md`。

生产 `/monitor.json` 已有 `segments_played_body`、`segments_skipped_body`、`segments_dropped_body` 字段，目前均为 0；生产尚无更新后的 Body 在线发送真实回执，因此这不是生产回执链路实跑计数。Hub 启动恢复发现 trace 第 49、104 行各有一条格式损坏记录，跳过并追加 `trace.recovered` 事件；原 trace 没有清洗或重写。

| Provider | 地址 | 最近证据 | 状态 |
|---|---|---|---|
| ASR | `127.0.0.1:9881` | HTTP 200；Qwen3-ASR CUDA；源 WAV 转写逐字正确 | Provider/WAV 路径 verified |
| LLM | `127.0.0.1:18081` | `/v1/models` HTTP 200；Qwen3-0.6B-Q8_0 | 最近健康检查通过 |
| TTS | `127.0.0.1:18080` | `/healthz` HTTP 200；upstream alive | 正式 TTS 验收通过 |

## 能力状态

| 能力 | 状态 | 证据 |
|---|---|---|
| WebSocket v1、ASV1 PCM16、未知 type 非致命兼容 | accepted | `docs/protocol.md`、`src/wire.rs`、schema 与协议测试；`D:\11\Logs\2026-10-26-protocol-unknown-type.md` |
| Native TTS、分段首段先播、打断、active handoff | accepted | `D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md`、`D:\11\Logs\2026-10-26-tts-segmented.md` |
| 120 秒整轮 TTS 预算 | accepted | `D:\11\Logs\2026-10-26-tts-turn-budget.md` |
| Trace 撕裂行恢复 | accepted | TTS 正式验收报告 §1.3、Rust 测试 |
| TTS 段级回执 | accepted；Hub 已部署，Body 端待更新客户端接入生产 | `D:\11\Logs\2026-10-27-tts-segment-receipts.md`、`D:\11\Logs\2026-10-27-tts-segment-receipts-production-deploy.md` |
| Provider 流式 PCM | blocked（已完成可行性测量） | `D:\11\Logs\2026-10-27-tts-streaming-pcm-可行性判定.md`；网关缓冲整段响应 |
| ASR Provider 与 WAV 回放 | verified | `D:\11\Logs\2026-10-26-asr-input-turn.md` |
| ASR 实麦通路 | accepted（任务制定者环境豁免，2026-10-26） | 完整音频经 Hub 回合、源 WAV 直连 Provider；`D:\11\Logs\2026-10-26-asr-input-turn.md`、`D:\11\Logs\2026-10-26-ASR实麦诊断与录音台.md` |

ASR 诊断结论：此前两次 Hub 实麦回合仅转写为“嗯”。本地默认耳机麦 Lenovo EH150P 为 16 kHz 单声道，但电平低且静音段占多数；内置 Realtek 阵列和两路虚拟麦在驱动层送全 0。声学回环中源 WAV 被逐字正确识别，同一音频的麦克风采集版本识别错误，故障定位到输入设备侧而非 ASR Provider/Hub。任务制定者因环境（耳机麦电平不足、平时不使用语音输入）免除实麦人工朗读条件；ASR 通过依据回到完整音频经 Hub 的 `audio.up` → ASR → LLM → TTS → Body 播放回合，以及源 WAV 直连 Provider 的逐字转写。设备选择、实时波形/频谱和录音台工具已实现，见 `absolute-solver-mic-probe`、`absolute-solver-mic-monitor`、`录音键.cmd`。

## 功能后续

这些项目是后续工作，不要与 Release 门槛混称为“唯一主任务”：

- 用 `录音键.cmd` 在可用设备上录制约 6 秒人工短句，逐字核对转写，作为可选 ASR 补证；当前不阻塞发布。
- 排查 Realtek 麦克风阵列送全 0（静音热键、Windows 输入电平、Realtek/Nahimic 驱动设置），或接入另一支可用麦克风。
- 恢复服务器远程开机：现场检查 BIOS/NIC 的 PCIe Wake-on-LAN 设置。
- 更新后的 Body 尚未部署到生产，因此生产 Body 侧分段回执还没有实跑数据；任务卡 `docs/tasks/2026-10-26-tts-segment-receipts.md` 已 accepted，Hub 字段已上线。
- Provider 侧流式 PCM 已测量但 blocked：直连 Provider 真流式，经网关变成整段缓冲；解除步骤见 `docs/tasks/2026-10-26-tts-streaming-pcm.md` 和可行性报告。
- Presence 覆盖层提前撤销仍待生命周期审计；机器人 Nav2/实体运动未验收。

## Release 阻塞项

ASR 实麦人工朗读条件已由任务制定者因环境免除；完整音频经 Hub 回合的历史证据已满足当前验收，不是当前 Release 阻塞项。创建 `v0.3.0` tag/Release 前仍需：

1. 轮换历史日志中出现过的 Presence token 与服务器账户凭据，验证旧凭据失效，并记录 Hub 实际网络访问边界；Hub 当前无中心认证且链路未加密。
2. 发布构建 `0.3.0`、SHA256、生产备份及回滚已在任务 A 部署中核验并实跑；但发布资产命名仍需改用与内容一致的版本名。历史活动路径带 `v0.2.1`，不能仅凭文件名识别版本。
3. 查明生产 turn 41 到 turn 18 之间是 trace 归档还是替换，建立新旧 trace 对应关系。

测试通过不等于发布证据齐全。无上述记录前，不创建 `v0.3.0` Release。

## 历史事实纠偏

- 线上协议是 WebSocket v1 + 二进制媒体；`docs/WIRE_PROTOCOL_V2.md` 是未采纳设计稿，以 `docs/protocol.md`、`src/wire.rs` 和生成 schema 为准。
- 生产地址以 `LAN_HUB_ADDRESS` 为准；`LAN_HUB_ADDRESS` 是历史不可达测试地址。
- 2026-10-23 turn 41 与 2026-10-26 turn 18 不能拼成连续生产序列，断点尚待 Release 阻塞项核实。
