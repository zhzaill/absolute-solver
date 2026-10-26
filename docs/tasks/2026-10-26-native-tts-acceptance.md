# Native TTS Production Acceptance

任务 ID：native-tts-acceptance
需求来源：`docs/TTS_REQUIREMENTS.md`、`docs/REQUIREMENTS_INDEX.md`
目标：验收 Hub 经 TTS Provider 合成 PCM16 后，通过 active Native Audio Body 实际播放，并证明故障降级与恢复。
优先级：P1（核心用户链路）
范围：Hub TTS 调用、PCM 解码、Body 路由与播放、错误降级及恢复验收。
不在范围：ASR 输入、Presence 生命周期、gRPC、流式 TTS、压力与并发测试。
前置条件：Hub、TTS Provider、Native Audio Body 和实际扬声器可用。
输出位置：代码和测试在仓库；正式运行报告为 `D:\11\Logs\2026-10-26-Absolute-Solver-TTS正式验收.md`；诊断音频及运行产物位于 `D:\11\Logs\tts\`。
验收条件：Provider 合成合法 WAV；PCM16 到达 active Body 并实际播放；第二 Body 隔离与 active handoff 生效；Provider 故障、非法 WAV、无 Body 和恢复均可观测；Rust 测试通过。
风险与回滚：播放验收依赖当前服务器和操作者笔记本设备；若环境变化导致 active Body 或实际播放失效，撤销 accepted 状态并重跑正式验收。
状态：accepted（2026-10-26）
