# Absolute Solver 当前可信项目现状

更新时间：2026-10-26（Asia/Shanghai）
适用范围：仅 Absolute Solver 仓库、其 Hub/Body/Provider 运行链路与相关验收证据。
状态类型：当前快照，不是历史计划，也不替代运行 Logs。

## 证据规则

这份手册是索引，不是第二个事实源。事实优先级固定为：

1. 当前代码、测试输出和实际运行命令；
2. `D:\11\Logs` 下带日期的运行报告、trace、monitor 快照和部署校验；
3. 本文件和其他 `docs` 只做带证据路径的摘要。

## 系统视角

Absolute Solver 是跨主机运行的实时协作系统：Hub 编排回合和 Provider 调用，Body 连接真实设备并执行音频采集与播放，ASR/LLM/TTS Provider 可独立部署在其他主机。Hub 是逻辑协调点，但当前没有中心身份认证；WebSocket 局域网链路也未加密。因此 Presence token 不能被误读为 Hub 全局认证，部署边界和凭据轮换属于系统能力的一部分，而非外围运维细节。

计划书不能单独改变状态。历史报告不被覆盖；后续结果用追加勘误关闭旧边界。

## 当前仓库

- GitHub：`https://github.com/zhzaill/absolute-solver`
- 分支：`main`
- 同步状态：本地 `main` 与 `origin/main` 一致；工作区干净。
- 当前代码版本：Cargo `0.3.0`。
- 已提交主线：Native TTS/restart recovery、segmented TTS、interruptible bounded playback、有界 Windows 麦克风采集、协议/状态索引纠偏和当前状态手册。
- GitHub 尚无 `v0.3.0` tag/Release；自动化测试通过，但发布验收项尚未齐备，见下方未完成事项。

## 运行快照

### Hub

- 地址：`LAN_HUB_ADDRESS:18100`，生产地址以此为准。
- 版本：`0.3.0`；状态 `idle`；当前 turn `46`。
- 当前连接数：`0`；active Body：无。
- 当前 monitor 计数是进程快照，不代表历史累计验收：`tts_ok=3`、`say_sent=3`、`say_undelivered=0`；ASR/LLM 当前进程计数为 0。
- 证据：当前 `GET /monitor.json`；历史真实验收见 `D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md` 与 `D:\11\Logs\2026-10-26-asr-input-turn.md`。

### Provider

服务器现有计划任务和健康检查均通过：

| Provider | 地址 | 当前结果 | 证据 |
|---|---|---|---|
| ASR | `127.0.0.1:9881` | HTTP 200；Qwen3-ASR `cuda`；真实麦克风两次只识别为“嗯” | `D:\11\Logs\2026-10-26-asr-input-turn.md`、服务器 `E:\modelsvc\asr_server.log` |
| LLM | `127.0.0.1:18081` | `/v1/models` HTTP 200；Qwen3-0.6B-Q8_0 | 当前远程健康检查、turn 28-31 trace |
| TTS | `127.0.0.1:18080` | `/healthz` HTTP 200；upstream alive | `D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md`、当前远程健康检查 |

### Body

- Native Audio Body 的完整 WAV/PCM16/active handoff/故障恢复已通过正式验收。
- `src/bin/body.rs` 现在支持显式 `SOLVER_CAPTURE_SECONDS` 的一次性 Windows 默认麦克风采集，限制 1-30 秒、内存中分片发送、默认关闭。
- 两次真实采集（turn 30/31）都完成 ASR → LLM → TTS → Body 播放，但 ASR 只返回“嗯”，所以 ASR 任务仍为 `verify`。
- 当前没有后台麦克风采集，也没有 active Body。

## 已验收能力

| 能力 | 当前状态 | 证据 |
|---|---|---|
| WebSocket v1 + ASV1 二进制媒体 | accepted | `docs/protocol.md`、`src/wire.rs`、协议测试 |
| 未知 `type` 非致命兼容 | accepted | `D:\11\Logs\2026-10-26-protocol-unknown-type.md` |
| Native TTS 正式输出 | accepted | `D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md` |
| 分段 TTS/首段先播/打断/handoff | accepted | `D:\11\Logs\2026-10-26-tts-segmented.md` |
| 120 秒分段整轮预算 | accepted | `D:\11\Logs\2026-10-26-tts-turn-budget.md` |
| Trace 撕裂行恢复 | accepted | TTS 正式验收报告 §1.3、`src/lib.rs` 测试 |
| ASR Provider 健康和 WAV 回放回合 | verified | `D:\11\Logs\2026-10-26-asr-input-turn.md` |

## 未完成和真实边界

- ASR 实麦识别质量：两次真实采集均为“嗯”，需要排查默认输入设备、电平、采样和端点；不能称为语音输入闭环完成。
- Body 侧分段播放/丢弃计数尚未上报 Hub monitor；任务卡 `docs/tasks/2026-10-26-tts-segment-receipts.md`。
- Provider 侧流式 PCM 尚未开始；任务卡 `docs/tasks/2026-10-26-tts-streaming-pcm.md`。
- Presence 覆盖层提前撤销仍待生命周期审计。
- Hub 当前无鉴权、局域网明文监听；凭据轮换任务 `docs/tasks/2026-10-26-credential-rotation.md` 已建立但未执行。
- 机器人 Nav2/physical motion 尚未验收；发布 tag/release、构建产物与回滚核验、trace 归档映射仍未收束。

## 历史连续性和命名

- 2026-10-23 Presence 报告记录 turn 41；2026-10-26 TTS 重启恢复记录 turn 18。两者之间存在 trace 替换或归档断点，不能拼成连续生产序列。
- 运行版本是 0.3.0，但服务器历史二进制、trace 和备份路径带 `v0.2.1` 文件名。回滚必须核对二进制版本和 SHA256，不能凭文件名判断。
- `LAN_HUB_ADDRESS` 只属于预算验收时不可达的历史测试地址；当前生产地址为 `LAN_HUB_ADDRESS`。

## 下一项功能主任务

排查 ASR 实麦仅识别为“嗯”：先确认 Windows 默认输入设备与电平，再用一条可复核短句做单 Body 采集，要求 ASR 转写与口述一致，并留下 Hub/ASR trace 与播放证据。完成前保持 `verify`。

## Release 阻塞项

以下事项与 ASR 功能任务并行存在，是创建 `v0.3.0` Release 前的独立证据门槛：

- 凭据轮换：历史日志已脱敏，但旧 Presence token 和服务器密码是否失效尚未核验；Hub 仍无中心认证，局域网链路未加密。
- 构建与回滚：生成待发布构建，记录版本和 SHA256，并验证回滚文件；历史文件名含 `v0.2.1`，实际代码为 `0.3.0`，不能按文件名回滚。
- Trace 连续性：确认 turn 41 到 turn 18 是 trace 归档还是替换，并留下旧、新 trace 的对应关系。
