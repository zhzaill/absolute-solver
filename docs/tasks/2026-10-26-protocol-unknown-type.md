# Protocol Alignment: Unknown Message Types

任务 ID：protocol-unknown-type
需求来源：`docs/REQUIREMENTS_INDEX.md`、`docs/PROJECT_EXECUTION_METHOD.md`
目标：使 v1 文档、Rust decoder、Hub 行为和生成 schema 对未知消息类型采用一致的前向兼容策略。
优先级：P0（协议权威/兼容性）
范围：`docs/protocol.md`、`src/wire.rs`、`src/bin/hub.rs`、`src/bin/protocol_schema.rs`、`schemas/`
不在范围：协议主版本迁移、消息类型改名、TTS/Presence 行为和此前工作区已有的其他功能改动。
前置条件：Rust stable 工具链可用。
输出位置：源码及 schema 位于仓库；验收报告写入 `D:\11\Logs\2026-10-26-protocol-unknown-type.md`。
验收条件：未知 v1 类型可区分于已知类型字段错误；Hub 对未知类型返回非致命 `unknown_type`；schema 接受未知扩展类型但继续约束已知类型；重新生成 schema 无差异；相关 Rust 测试通过。
风险与回滚：schema 泛化可能导致未知帧通过结构校验，但 Rust Hub 仍按显式注册类型处理；若验证失败，恢复本任务新增的 decoder/schema/doc 改动，不回滚其他既有工作。
状态：accepted
