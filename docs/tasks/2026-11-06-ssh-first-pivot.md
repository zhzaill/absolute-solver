# 任务卡：把 Cortico 的能力投影到设备（SSH 优先）

日期：2026-11-06（Asia/Shanghai）
状态：`direction`（方向已定，实现待做）

## 决策

- 放弃旧的 **Presence（存在位置）** 与 **「无门权限」连续连接** 模型；旧实现归档在 `archive/pre-ssh-2026-11-06` 分支，不进入新主线。
- 新主线：**把 Cortico 的能力投影到每台设备**——页面、声音、工作区/工具；Cortico 通过 SSH 抵达，每台设备本地同时运行 ASR、TTS、LLM。
- Hub 退化为可选的设备登记表 / 事实账本：不做消息代理，不做临时授权门槛。

## 为什么

- 每台设备本来就能本地跑 ASR/TTS/LLM，集中式路由和 Presence 追踪是多余层。
- SSH 已经提供加密传输、主机身份校验、账户授权和端口转发——这正是旧模型用自建 WebSocket + token + grant 想做的事。
- 自定义的"无门权限"连续连接既绕过了真实账户权限，又需要自己维护一套安全语义，不适合现状。

## 第一版边界

1. 只连接登记表中的 `host / port / user / key`，`known_hosts` 固定，不连任意地址。
2. 设备本地 ASR/TTS/LLM 用各自既有端口；Cortico 通过 `ssh` 远程命令或 `ssh -L` 隧道访问。
3. 回执 = 真实 SSH 会话的退出码 + stdout/stderr 分类 + 耗时。
4. 不保存完整正文、完整音频、token、服务密钥或私钥。
5. 撤销 = 移除 `authorized_keys` / `known_hosts` 条目或停用账户；之后连接必须失败。

## 验收

- Cortico 主机能 `ssh` 到至少两台设备，分别调用设备本地的 ASR、TTS、LLM，并拿回真实回执。
- 目标设备上真的出现 Cortico：页面可见、声音播放、工具可执行，并有真实回执。
- 设备离线或本地服务未启动时，明确报告失败，不伪造成功。
- 撤销后新连接失败，且错误如实返回。
- 登记表能用 `device_id` 关联设备、能力、最近回执，但不含秘密或完整内容。

## 待办

- [ ] 定义登记表 schema（`device_id / host / port / user / key_ref / capabilities / last_receipt`）
- [ ] SSH 连接与远程命令执行的最小实现
- [ ] 本地 ASR/TTS/LLM 调用封装（远程命令 + 端口转发）
- [ ] 结构化回执（退出码 / 输出分类 / 耗时）
- [ ] 撤销流程与失败回执

## 范围外

- 新的 WebSocket/A2A 消息代理、Presence token、一次性 grant；
- 第二个 Agent 或第二个决策中心；
- 把多台设备的 ASR/TTS/LLM 集中到单机。
