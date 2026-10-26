# Absolute Solver 当前可信项目现状

更新时间：2026-10-26（Asia/Shanghai）  
适用范围：仅 Absolute Solver 仓库、Hub/Body/Provider 运行链路及其验收证据。本文是日期快照，不代替源代码、实际运行结果和 `D:\11\Logs` 原始报告。

## 证据规则

当前代码、测试输出和实际运行记录优先；`D:\11\Logs` 保存验收证据；本文件只做摘要与索引。计划文档和状态措辞本身不能把功能改成 `accepted`。新证据应追加到日志并更新本手册，不覆盖历史结论。

## 系统与安全边界

Absolute Solver 是跨主机实时协作系统：Hub 编排回合、Body 路由和 Provider 调用；Body 连接真实设备并执行音频采集/播放；ASR、LLM、TTS 可独立部署。Hub 是逻辑协调点，但当前没有中心身份认证，局域网 WebSocket/HTTP 链路未加密。Presence token 只用于受限的 Presence 流程，不是 Hub 全局认证。

部署仅适用于可信局域网，不应直接暴露公网。历史日志曾出现 Presence token 和服务器密码，现已脱敏；凭据是否已轮换尚未核实。

## 仓库快照

- 仓库：`https://github.com/zhzaill/absolute-solver`，分支 `main`。
- 应用版本：Cargo `0.3.0`；GitHub 尚无 `v0.3.0` tag/Release。
- 最近已提交的本地代码包含 ASR 设备选择、麦克风诊断工具和录音台；该提交尚未推送到 `origin/main`。
- 本次快照中工作区另有 `docs/PROJECT_EXECUTION_METHOD.md` 与 `docs/tasks/2026-10-26-asr-input.md` 的未提交修改。不要把工作区描述为干净。
- 自动化验证已通过：`cargo fmt --check`；39 个库测试、11 个 Body 测试、20 个 Hub 测试；协议 schema 生成检查曾在缺少生成文件时失败，随后补交 schema 后通过。

## 运行快照

最近一次服务器状态记录：Hub `LAN_HUB_ADDRESS:18100`、版本 `0.3.0`、turn 46、idle、无 active Body；ASR/LLM/TTS 健康检查此前均通过。服务器在 2026-10-26 23:00 左右休眠，WoL 未唤醒，因此这些是休眠前快照，不应当作当前在线保证。现场开机或在 BIOS/NIC 启用 PCIe 网络唤醒后再复查。

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
| ASR Provider 与 WAV 回放 | verified | `D:\11\Logs\2026-10-26-asr-input-turn.md` |
| ASR 实麦通路 | accepted（操作者判定，2026-10-26 23:15） | `D:\11\Logs\2026-10-26-ASR实麦诊断与录音台.md` |

ASR 诊断结论：此前两次 Hub 实麦回合仅转写为“嗯”。本地默认耳机麦 Lenovo EH150P 为 16 kHz 单声道，但电平低且静音段占多数；内置 Realtek 阵列和两路虚拟麦在驱动层送全 0。声学回环中源 WAV 被逐字正确识别，同一音频的麦克风采集版本识别错误，故障定位到输入设备侧而非 ASR Provider/Hub。操作者将实麦通路判定为 `accepted`；人工朗读逐字一致属于后续补证，不阻塞发布判定。设备选择、实时波形/频谱和录音台工具已实现，见 `absolute-solver-mic-probe`、`absolute-solver-mic-monitor`、`录音键.cmd`。

## 功能后续

这些项目是后续工作，不要与 Release 门槛混称为“唯一主任务”：

- 用 `录音键.cmd` 在可用设备上录制约 6 秒人工短句，逐字核对转写，作为 ASR 补证；当前不阻塞发布。
- 排查 Realtek 麦克风阵列送全 0（静音热键、Windows 输入电平、Realtek/Nahimic 驱动设置），或接入另一支可用麦克风。
- 恢复服务器远程开机：现场检查 BIOS/NIC 的 PCIe Wake-on-LAN 设置。
- Body 分段播放/丢弃回执尚未上报 Hub monitor；Provider 侧流式 PCM 尚未开始。
- Presence 覆盖层提前撤销仍待生命周期审计；机器人 Nav2/实体运动未验收。

## Release 阻塞项

ASR 实麦已按操作者判定通过，不是当前 Release 阻塞项。创建 `v0.3.0` tag/Release 前仍需：

1. 轮换历史日志中出现过的 Presence token 与服务器账户凭据，验证旧凭据失效，并记录 Hub 实际网络访问边界；Hub 当前无中心认证且链路未加密。
2. 生成待发布构建并记录版本/SHA256，核验部署与回滚文件。历史文件名带 `v0.2.1`，运行代码为 `0.3.0`，不能仅凭文件名回滚。
3. 查明生产 turn 41 到 turn 18 之间是 trace 归档还是替换，建立新旧 trace 对应关系。

测试通过不等于发布证据齐全。无上述记录前，不创建 `v0.3.0` Release。

## 历史事实纠偏

- 线上协议是 WebSocket v1 + 二进制媒体；`docs/WIRE_PROTOCOL_V2.md` 是未采纳设计稿，以 `docs/protocol.md`、`src/wire.rs` 和生成 schema 为准。
- 生产地址以 `LAN_HUB_ADDRESS` 为准；`LAN_HUB_ADDRESS` 是历史不可达测试地址。
- 2026-10-23 turn 41 与 2026-10-26 turn 18 不能拼成连续生产序列，断点尚待 Release 阻塞项核实。
