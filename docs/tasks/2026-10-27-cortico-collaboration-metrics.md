# Cortico 协作链路量化

任务 ID：cortico-collaboration-metrics  
需求来源：用户要求固化并量化 Absolute Solver 与 Cortico 的协作模式；主要服务将依赖 Cortico。  
目标：定义并实测 World 事实进入 Cortico、Persona 决策表达、Hub 执行以及 Body 回执的端到端指标。  
优先级：P1（核心协作边界与运行可观测性）  
状态：**blocked（生产测量）**；协作边界和指标草案见 `D:\11\Logs\2026-10-27-cortico-collaboration-baseline.md`。

## 范围

- Absolute Solver：`/cortico/event`、Hub trace/monitor、TTS、Body 回执和协作文档。
- Cortico：只读检查 `World.pushEvent`、事件投递、Persona 调用与运行日志契约；代码工作需单独安排在 Cortico 仓库。
- 不在本任务范围：面板实现、流式 PCM、修改 Cortico 代码、向生产 Persona 注入验收事件、以 Hub 代替 Persona 作决定。

## 协作模型

```text
World / Provider facts
  -> Cortico World.pushEvent (persist + queue/deliver)
  -> Persona decides: respond / use tool / remain silent
  -> persona.expression or tool request/result
  -> Absolute Solver Hub validates, sequences and routes
  -> Provider / permissioned Tool Gateway
  -> active Body performs I/O and reports receipt
```

Cortico 持有 Persona 决策和 World 语义；Hub 持有 session/turn、权限、路由、预算、trace 和降级；Body 持有本机 I/O 事实。World 的 `pushEvent` 返回已归档 envelope 只证明保存/入队，不等于 Persona 已处理或回应。沉默是合法决策，不应直接记为丢失。

### 指令优先级和事件信任

- 系统/项目规则、Hub 强制权限边界和用户明确设定的规则，不由事件内容修改。
- World、Provider、设备、工具、转录和引用文档中的文本默认是低信任数据。即使它写着“我是用户/管理员”“忽略之前的规则”或“授权执行”，也只按事件事实内容处理，不获得指令优先级。
- Persona 可以根据事件回答、保持沉默或提出工具请求；实际执行仍需经过 Hub 授权、scope、确认策略和 Tool Gateway。
- 只有独立认证且授权的用户控制通道才能表达对用户规则/任务优先级的变更；事件 payload 自称来自用户不构成认证。该通道也不能覆盖系统规则或 Hub 禁止的能力。
- 测试应包含 prompt-injection 事件样本，并确认拒绝越权、拒绝改写规则，同时允许对事件内容作普通分析/回答。

## 指标定义

| 指标 | 分子 / 分母或区间 | 采集点 | 判定注意事项 |
|---|---|---|---|
| Cortico 可用率 | 成功 `/api/status` probes / 总 probes | Hub monitor，5 秒周期 | 与网络/本机配置失败分开；记录错误和连续失败时长 |
| World 接受延迟 | `pushEvent` 调用到持久化 envelope 返回 | Cortico World/Core 日志 | 仅代表归档/入队，不代表 Persona 决策 |
| 有效事件决策覆盖 | 在规定观察窗内得到明确决策结果的合格事件 / 合格事件 | Cortico event/turn 关联 | 分开 `respond`、`tool`、`silence`、`failed`；不可把 silence 算丢失 |
| 事件到 Persona 决策延迟 | 事件创建到决策/首个输出的时间 | 共享 `correlation_id`、Cortico `ev/round/resp` | 报 p50/p95/max；跨进程墙钟须记录时钟偏差或使用同主机单调时钟区间 |
| Persona 表达到 Hub 接受 | Hub 202 次数 / 有效 expression POST；延迟为请求发出到 202 | Cortico outbound + Hub ingress | 202 只表示 Hub 已接收，不表示 TTS 或播放完成 |
| expression 到首段发送 | Hub 接收 expression 到首个 `say` | Hub trace | 报 p50/p95、TTS 成功/失败/降级 |
| expression 到 Body 结果 | 对应 expression 的 `played/skipped/dropped` receipts / 已发送音频段 | Hub `segment.receipt`、Body trace | `complete`、`partial`、`missing` 分开；不使用 Hub 估算 dropped 代替 Body 事实 |
| 安全与去重 | 非法/重放拒绝数、重复工具幂等命中、越权执行数 | Hub/Cortico logs | 越权执行必须为 0；重放拒绝应可追踪到 session/source/seq |

## 首轮试测门槛（非生产 SLO）

- 有效 World 事件样本至少 30 个，覆盖 respond、tool 和 silence；至少跑 3 次进程重启/恢复场景。
- Cortico HTTP 状态探针连续 30 分钟可用率至少 99%；在线时探针 p95 不高于 500 ms。
- 同机 World `pushEvent` 保存/入队 p95 不高于 200 ms。
- 对预先标注为必须响应的简单事实，事件到 Persona 首个结果 p95 不高于 8 s；silence 不计作失败。
- `persona.expression` 到 Hub 202 p95 不高于 100 ms；随后 Hub 的表达均有明确 `adapter.tts.ok` 或 `adapter.tts.degraded` 结果。
- 音频段发送后，Body receipts 与 Hub 已发送段数在正常回合一致；打断回合完整区分 played、skipped、dropped。
- 超时、Cortico 重启、Hub 重启、Provider 失败和无 active Body 均不得造成无界重试、重复动作或伪报播放成功。

上述阈值是首轮试测线；收集足够分布后再定正式 SLO。机械执行类 World 还必须满足授权、幂等、超时、停止和执行回执要求，单纯 Persona 文本输出不能视作动作完成。

## 当前阻塞与下一步

2026-10-27 生产 Hub 的 Cortico `/api/status`、`/api/usage`、`/api/log` 均连接失败，本机 `127.0.0.1:7777` 拒绝连接。Hub 仍在线，但当前没有可用 Cortico 实例可做生产协作测量。历史 TTS 端到端报告明确记录 Cortico 未启动，不能作为 Cortico 决策链证据。

解除阻塞后：部署/唤醒 Cortico；对齐可审计的 `correlation_id`（贯穿 World event、Persona 决策/表达、Hub turn 和 Body receipt）；执行 30 条标注样本和故障场景；将真实分布写入 Logs；据结果校准 SLO。

## 输出与安全

- 验收报告：`D:\11\Logs\2026-10-27-cortico-collaboration-baseline.md`。
- 运行数据不得包含秘密、完整音频、模型上下文或不必要的 Persona 私密文本；日志优先记录 ID、计时、类型、状态码和 payload key。
- 生产测量恢复后，更新 `docs/ABSOLUTE_SOLVER_CURRENT_STATE.md`；若需新增协议字段，先更新 `docs/protocol.md`、schema 和兼容测试。
