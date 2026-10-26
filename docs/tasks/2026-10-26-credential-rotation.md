# Credential Exposure and Rotation

任务 ID：credential-rotation
需求来源：2026-10-26 文档证据审计
目标：轮换曾在历史部署日志中明文出现的 Presence token 与服务器账户凭据，并确认 Hub 网络访问边界。
优先级：P0（凭据暴露与权限边界）
范围：服务器 Presence token、Hub 启动配置、服务器账户 SSH 凭据及相关运行文档。
不在范围：扩大 Hub Presence scope、引入完整认证系统或改变协议主版本。
前置条件：需验证部署权限与可回滚的 Hub 配置；轮换前确认 Host/Hub 的当前 token 依赖。
输出位置：代码/配置在现有部署位置；验收报告写入 `D:\11\Logs\YYYY-MM-DD-credential-rotation.md`；不得在报告中记录新凭据。
验收条件：旧 Presence token 被拒绝、新 token 完成授权链路；SSH 旧密码失效且密钥/新密码可登录；文档和日志无明文凭据；记录 Hub 局域网鉴权风险及实际监听边界。
风险与回滚：Presence token 轮换会使现有 Host 授权失效；应先确认 Hub/Host 更新顺序并保留不含秘密的回滚步骤。服务器账户密码变更可能影响其他 SSH 自动化，轮换前需盘点依赖。
状态：captured（历史明文已脱敏；凭据是否仍有效及是否已轮换尚未核验）
