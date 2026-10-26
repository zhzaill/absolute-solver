# Absolute Solver 总项目报告 v2

当前可信状态手册：`docs/ABSOLUTE_SOLVER_CURRENT_STATE.md`；对应运行报告：`D:\11\Logs\2026-10-26-Absolute-Solver-当前可信状态.md`。本文保留为历史快照和架构背景，不作为实时状态源。

日期：2026-10-25
状态：核心基础设施在线，机器人方向已接入监视器，核心协议待并入

> 状态校正（2026-10-26）：本文运行快照仍保留 10-25 时点。Native TTS 和未知消息类型兼容性已由 `D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md` 通过实机验收；ASR 后续已启动并实跑，但两次实麦仅识别为“嗯”，因此仍是 verify。本文中旧的 active Body/ASR 描述不能覆盖后续报告。Presence 覆盖层和机器人运动状态不因这些报告改变。

## 结论

Absolute Solver 当前已经形成可运行的“一个 Mind、多种 Body、多个 World”骨架：

- Hub 是回合、路由、权限、TTS 调用和 trace 的唯一权威。
- Cortico 是 Persona/World 层，负责决定是否表达，不拥有 Body 权限。
- XuegerOS 是机器人 Body/World 运行时，不成为第二个 Mind。
- DSH 插件是操作者驾驶舱和 World 注入入口，不直接拥有运动或模型决策权。
- Host Presence 已能在 Hub、Cortico 和本机 Host 之间走通授权流程，但覆盖层驻留仍需修复。
- 服务器 TTS、LLM、Cortico、VLA、VM、micro-ROS、建图和 Robotics World 监视已同时在线。
- Native TTS 输出闭环已于 2026-10-26 通过正式运行验收；ASR Provider、LLM 与实麦采集回合已运行，但两次只转写为“嗯”，真实语句识别仍未完成。详见 `D:\11\Logs\2026-10-26-asr-input-turn.md`。

本轮报告是核心协议并入前的基线。用户提供的核心协议到位后，应以它为主骨架重新核对身份、事件、权限、回执和媒体边界。

## 项目清单

| 项目 | 位置 | 当前职责 | 状态 | 收束结论 |
|---|---|---|---|---|
| Absolute Solver | `D:\11\Projects\Absolute Solver` | Rust Hub、协议 v1、回合、Body 路由、记忆、TTS 适配、Presence、监视器 | `0.3.0`，服务器在线 | 保留为主干 |
| Tauri Host | `desktop/tauri-host` | 本机托盘、Presence 本地策略、全屏覆盖层、撤销 | 代码完成，生产覆盖层驻留未验收 | 保留为 Host 权限面 |
| Cortico Server | `E:\Absolute-Solver-Cortico-local` | Persona、World、`persona.expression`、Host/Solver World | `0.2.7` 正在 `7777` 运行 | 保留为 Persona 层 |
| Coopanion | `E:\Coo-0.2.10-20261025` | Windows 桌宠宿主和 Coo CUA 表面 | `0.2.10` 已部署，计划任务 Ready，未首启 | 保留为可选桌面 Body |
| XuegerOS | `D:\11\Projects\xuegeros` | VM、相机、micro-ROS、建图、只读 Adapter、运动网关与 ROS 安全 | VM/相机/建图/Adapter 在线 | 保留为机器人 Body/World |
| `dsh-xuegeros` | `D:\11\Projects\xuegeros\dsh-xuegeros` | 驾驶舱、VLA 循环、World 注入、人工确认驾驶 | 运行中，18 项自测通过但测试进程未自行退出 | 保留为操作者界面 |
| `cortico-world-camera` | `D:\11\Projects\Portal\packages\cortico-world-camera` | Cortico 控制台相机/VLA 扩展，npm `0.2.0` | 已发布，独立实验链路 | 保留为 World 扩展，不并入 Hub |
| NoMaD VLA | `E:\vla\nomad` | 相机帧到差速提案 | 真权重、CUDA、上下文 4 帧、约 210–225 ms | 保留为感知/提案 Provider |
| GPT-SoVITS TTS | `E:\GPT-SoVITS` | 本地音色合成与 OpenAI 兼容网关 | `9880/18080` 在线，缓冲 WAV | 保留为 Hub Provider |
| DSH TTS Plugin | `D:\11\Repos\dsh-tts` | 既有 TTS 工具、同源缓存、语言声明和 SSE 客户端 | 已装入 desktop profile；通过本地 `18080` 转发接 GPT-SoVITS | 保留，禁止重复实现 |
| Qwen LLM | `E:\llm` | Persona 推理的上游模型 | `18081` 在线，Qwen3-0.6B-Q8 | 保留为模型 Provider |
| Qwen ASR | `E:\modelsvc` | 语音转写 | `9881` 已启动；实麦回合已跑但识别质量未通过 | 排查默认输入设备、电平与端点 |
| Hub 记忆 | SQLite/FTS5 | 回合记忆、检索、上限与回退 | 可用 | 保留，不上升为第二决策层 |
| Live2D/VTS Stage | `stage/`、历史 artifacts | 早期演出探索 | 当前停用 | 归档，不作为本轮主线 |
| gRPC 迁移 | `docs/GRPC_*`、历史评估 | 协议迁移研究 | 未采用 | 保持 WebSocket v1 |

## 权威边界

| 能力 | 权威所有者 | 禁止事项 |
|---|---|---|
| Persona 决策 | Cortico | 不拥有 Body 注册、权限、TTS 路由和 trace |
| 回合与 Body 路由 | Hub | Body/World 不能自行创建第二套会话权威 |
| World 事实 | World Adapter | 不能把事实投递等同于工具执行权限 |
| 本机 Presence | Hub 授权 + Host 本地策略 | 在线不等于麦克风、摄像头、屏幕、文件或终端权限 |
| 语音输出 | Hub + TTS Provider | 模型或 World 不能直接选择任意扬声器 |
| 运动 | 人工确认 + Motion Gateway + ROS 安全 | VLA、Cortico、Persona 不能直接写 `/cmd_vel` |
| 视觉 | Body Adapter / NoMaD | 原始帧和 tensor 不进入 Persona、记忆或 trace |
| 监视 | Hub Monitor | 只读投影，不成为控制通道 |
| 连续性 | JSONL trace + `D:\11\Logs` | 未记录的事实不视为已继承状态 |

## 当前数据流

```text
相机 MJPEG
  -> XuegerOS Body Adapter（单槽内存帧）
      -> /v1/frames/latest.jpg -> DSH VLA loop -> NoMaD 提案
      -> /v1/world -> reverse SSH tunnel -> Hub Robotics World Monitor

XuegerOS / DSH World facts
  -> injectWorld -> Cortico/DSH Persona context

Cortico persona.expression
  -> Hub /cortico/event
  -> TTS Provider
  -> WAV -> PCM16
  -> active Native Audio Body（2026-10-26 验收设备：`body-native-b`）

Hub Presence intent
  -> Tauri Host local policy
  -> notify / appear / reject
  -> TTL grant / revoke
```

当前有两个机器人事实出口，但用途已分开：

- DSH `injectWorld` 是 Persona 的事实入口。
- Hub Robotics World 是只读监视投影，不投递工具权限，也不消费 VLA 帧槽。

## 当前运行快照

### Hub

- 版本：`0.3.0`
- 地址：`http://LAN_HUB_ADDRESS:18100`
- 当前生产服务器地址以 `LAN_HUB_ADDRESS` 为准；`LAN_HUB_ADDRESS` 仅出现在 2026-10-26 本机预算验收的“生产服务器不可达”历史记录，不是当前生产地址。
- 状态：`idle`
- 连接数：`0`
- active Body：无
- 连接错误：`0`
- 协议错误：`0`
- 监视器页面：HTTP `200`
- Cortico 监控：`ok=true`
- TTS：`ok=true`
- LLM：`ok=true`
- ASR：Provider 已运行；实麦识别仍处于 verify

### TTS

- 形态：GPT-SoVITS v2Pro + OpenAI 兼容网关
- 上游：`127.0.0.1:9880`
- 网关：`127.0.0.1:18080`
- 音色：`xxx_trained`
- 文本语言：`zh`
- 参考语言：`zh`
- 输出：32 kHz 单声道 WAV，Hub 解码为 PCM16
- 流式：未实现
- 集成验收：2026-10-26 实机完成 `persona.expression` → Provider → PCM16 → Native Audio Body 扬声器播放；完整证据见 `D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md`
- 历史性能：P104 上 RTF 约 `0.47–0.56`
- DSH 插件配置：`C:\Users\zhzaill\.dsh\profiles\desktop\node_modules\dsh-tts\cordis.patch.yml`
- DSH 客户端地址：`http://127.0.0.1:18080/v1`，音色 `xxx_trained`
- 本机到服务器使用正向隧道 `local 18080 -> server 18080`，服务器 TTS 不暴露到 LAN
- 插件客户端实测：endpoint reachable，生成 `126,764 B / 1.98 s / 32 kHz` WAV
- DSH 运行态 `/dsh-tts/status`：`upstream.ok=true`，当前进程已生效，无需重启
- DSH 既有插件：`D:\11\Repos\dsh-tts`，全局 `tts` 命令与 desktop profile 均已安装
- DSH 连接：本地 SSH 转发 `127.0.0.1:18080 -> server 127.0.0.1:18080`
- DSH 验收：`tts --status` reachable；`tts --check` 中/日 WAV 均通过

### LLM

- 地址：`127.0.0.1:18081`
- 模型：`Qwen3-0.6B-Q8_0.gguf`
- `/v1/models`：HTTP 200

### Cortico

- 版本：`0.2.7`
- 地址：`127.0.0.1:7777`
- Solver 注入：`127.0.0.1:18200`
- World：Console、QQ、WebSearch、Solver、Host
- Hub 监控：正常
- QQ 驱动：`127.0.0.1:3001` 未配置，持续重连

### XuegerOS / VM

- VM：`LEAP_ROSV2.1` running
- VMware Tools：`running`
- guest：`PRIVATE_LAN_ADDRESS/24`
- micro-ROS Agent：UDP `8888`
- micro-ROS client：session observed
- bringup：running
- Gmapping：running
- `/scan`、`/map`、`/tf`：present
- `/map`：width `384`
- Nav2：未启动
- 运动：物理可动，但当前 Persona/自动路径未启用

### 视觉与 VLA

- 相机：streaming
- Adapter：`127.0.0.1:18110`
- Vision 最新帧序号与年龄：已在 Hub 监视器正确投影
- NoMaD：`18300`，true weights、CUDA、`missing_keys=0`
- VLA context：`4/4`
- VLA latency：约 `210–225 ms`
- 最新 shadow proposal：`v=0.08`，`w` 在限幅内，`source=cockpit`

Hub 通过反向 SSH 隧道读取服务器回环端口：

```text
server 127.0.0.1:18110 -> local 127.0.0.1:18110
```

隧道由 `tools/start-robotics-tunnel.ps1` 维护，登录任务
`XuegerosRoboticsTunnel` 使用 WMI detached 启动器恢复，不在局域网新增
Adapter 监听。

### 运动网关

- 地址：`127.0.0.1:18111`
- 模式：shadow
- physical backend：unavailable
- lease max：`1000 ms`
- watchdog：`200 ms`
- 当前无 active lease

### Coo

- 版本：`0.2.10`
- 计划任务：`Coopanion`，Ready
- 服务器没有已登录交互桌面，因此未首启
- 服务器没有 QQ/Snowluma，不是群聊接入节点

## 本轮完成的修复

1. `start-vm` 不再用“有任意 VM 在跑”冒充目标 VM 成功。
2. VM 启动改为脱离 SSH 会话的 WMI 启动，并用 vmx 文件、`vmrun list` 和 VMware 进程命令行共同确认。
3. 远端 PowerShell 改为压缩传输，避免 Windows 8191 字符命令边界。
4. VM 恢复后通过 Guest Operations 补 DHCP，确认 `ens33`、Agent、bringup 和 Gmapping。
5. Hub 与 TTS 的 `prompt_lang` 从 `en` 修正为音色实际使用的 `zh`。
6. TTS 上游、TTS 网关、LLM、Cortico 全部恢复在线。
7. `vla-ctl.ps1` 不再把任意存活 PID 误认为 NoMaD。
8. DSH VLA loop 在 NoMaD 重启并丢失 process-local goal 后，会自动重新发 `/goal`。
9. Body Adapter 的最新帧序号/年龄现在会进入只读 vision 快照。
10. 新增反向 SSH 隧道 `server:18110 -> local:18110`，并增加登录任务和 WMI detached 启动器；Hub 不暴露局域网监听。
11. Hub `robotics_world.configured=true`、`ok=true`，监视器已显示真实机器人方向。
12. 同一条隧道增加正向 TTS 转发 `local:18080 -> server:18080`，并用 DSH 插件自己的客户端完成真实 WAV 合成。
13. 修复 Adapter 电池探针的可见 PowerShell 弹窗：子进程使用 `-WindowStyle Hidden` 和 `CREATE_NO_WINDOW`。

## 验证

- Absolute Solver：`cargo fmt --check` 通过；`27 + 15` 个 Rust 测试通过。
- XuegerOS：`15` 个 Python 测试通过。
- DSH：`18` 项自测输出通过；测试进程未自行退出，仍有开放句柄。
- PowerShell 与 Node 语法检查通过。
- `start-vm` 缺路径返回 `vmx_missing` 和 exit 1。
- `start-vm` 已运行时返回 `started=false / observedRunning=true`。
- Monitor：HTTP 200，体积约 `26 KB`。
- Hub Robotics：camera streaming、frame age 约几十毫秒、mapping true、micro-ROS true、navigation false、raw frame false。

## 未完成与阻塞

1. Presence 生产覆盖层仍会提前 `user_revoked`，本地生命周期审计尚未完成运行验收。
2. 2026-10-25 快照时没有 active audio Body；2026-10-26 已通过 Native Audio Body 实际播放和 handoff 验收。
3. ASR Provider `9881` 已启动；两次实麦回合均完成 ASR → LLM → TTS → 播放，但只识别为“嗯”，真实语句识别闭环仍未完成。
4. Nav2 未启动，`navigation_ready=false`。
5. 运动网关仍是 shadow，physical backend 不可用；自动运动未启用。
6. 机器人纯负角速度路径仍有历史间歇问题。
7. Guest DHCP 是短租约，NetworkManager 仍损坏。
8. Coo 未完成交互桌面首启与 CUA 安全行为验收。
9. GitHub 尚无 `v0.3.0` tag/Release。
10. 两个仓库都有未提交改动，当前状态是运行验证版，不是发布提交。

历史连续性说明：2026-10-23 Presence 部署报告记录生产 turn=41；2026-10-26 TTS 重启恢复报告记录 turn=18 且从 `E:\Absolute-Solver\trace\absolute-solver-v0.2.1.jsonl` 恢复。两者不能拼成一条连续 turn 序列，说明期间 trace 被替换或归档；后续发布必须保存 trace 归档映射。

部署命名说明：服务器运行代码为 0.3.0，但历史部署路径和备份仍带 `v0.2.1` 文件名。回滚必须以二进制内容/版本和 SHA256 为准，不能仅凭文件名判断版本。

## 收束原则

- 不再增加新的顶层项目；新能力必须先映射到 Body/World/Provider/Tool Gateway。
- 一个事实只允许一个权威入口；监视投影不能反向变成控制通道。
- Cortico 继续只做 Persona；Hub 继续持有权限和回合。
- TTS、ASR、LLM、VLA 都是 Provider，不持有会话状态。
- DSH 是操作者界面，不成为第二个 Hub。
- Coo 是可选桌面 Body，不获得群聊继承权限。
- 原始相机帧、tensor、音频 payload 不进入长期记忆和 trace。
- VLA 运动提案必须继续经过人工确认、租约、限幅和 watchdog。
- Live2D/VTS 暂停，不再消耗主线注意力。
- gRPC 保持延期，只有出现第三种非 Rust Body 或外部开发者接口时再评估。

## 待并入核心协议

用户找到的核心协议到位后，需要逐项映射：

1. 身份：Mind、Persona、Host、Body、World、Tool 的稳定 ID。
2. 会话：session、turn、sequence 和恢复边界。
3. 事件：事实、意图、决定、执行请求、回执五类是否分开。
4. 权限：scope、lease、TTL、撤销、人工确认和审计。
5. 动作：Tool Gateway 的幂等、超时、停止和回滚。
6. 媒体：控制帧、PCM、视频、字幕和对齐数据的边界。
7. 错误：结构化错误、重试、降级和可观测性。
8. 版本：兼容、迁移和扩展市场 API。

在这些映射完成前，本报告不宣称存在最终“核心协议”。
