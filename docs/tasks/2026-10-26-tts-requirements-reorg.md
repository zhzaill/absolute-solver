# TTS Requirements Reorganization

任务 ID：tts-requirements-reorg
需求来源：用户要求；当前 TTS 故事时长实测
目标：重新整理 TTS 要求手册，明确当前完整 WAV 能力与未实现的分段/流式设计，并规定所有代码、报告、音频和临时产物的绝对输出位置。
优先级：P1/P2 文档纠偏
范围：`docs/TTS_REQUIREMENTS.md`、`docs/REQUIREMENTS_INDEX.md`、TTS 输出位置和验收规则。
不在范围：实现分段 TTS、修改 WebSocket 协议、修改 Provider、重新验收 Native Body。
前置条件：已有 TTS 正式验收报告和故事时长实测报告。
输出位置：主手册在 `D:\11\Projects\Absolute Solver\docs\TTS_REQUIREMENTS.md`；索引在 `D:\11\Projects\Absolute Solver\docs\REQUIREMENTS_INDEX.md`；任务卡在本文件；变更报告在 `D:\11\Logs\2026-10-26-tts-requirements-reorg.md`。
验收条件：手册明确当前一次文本/一次 WAV/一次 `say.audio` 的实现；明确分段/流式未实现及未来最低要求；明确各类产物的绝对路径、命名和是否可作为验收证据；索引状态与手册一致。
风险与回滚：本任务只修改要求和索引，不改变运行代码；若文档校对失败，回滚本任务文档改动，不回滚 TTS 运行实现或报告。
状态：accepted
