# tailscale-broadcast.mjs — 交接说明

## 用途 / 入口

把本机的 host-projection 通过 **Tailscale Serve** 广播到 tailnet，得到 `https://<machine>.<tailnet>.ts.net/` 的有效证书 HTTPS 入口（仅 tailnet 内可见，不公网）。

- 入口：`node tools/tailscale-broadcast.mjs`
- 端口来源：`SOLVER_PROJECTION_PORT` → 配置 `listenPort` → `18111`

## 前置条件与依赖

- 已安装并登录 `tailscale`（PATH 中可用；本机实测 1.102.4）。
- `host-projection.mjs` 已在 `127.0.0.1:18111` 运行。
- Tailscale Serve 会把 tailnet 的 443 反代到 `http://127.0.0.1:18111`。

## 输入 / 输出与影响范围

- 无参数：`tailscale serve --bg <port>`，输出 tailnet 广播地址。
- `--status`：显示当前 serve 配置。
- `--reset`：清除 serve 配置（撤销广播）。
- 影响范围：修改本机 Tailscale Serve 配置（共享 tailnet 状态），不改仓库文件、不泄露密钥。

## 常用安全调用

```powershell
node tools/tailscale-broadcast.mjs            # 开启广播
node tools/tailscale-broadcast.mjs --status   # 查看
node tools/tailscale-broadcast.mjs --reset    # 撤销
```

## 验证方法

1. `node tools/tailscale-broadcast.mjs --status` 能看到 serve 规则。
2. 在 tailnet 内另一台设备打开 `https://<machine>.<tailnet>.ts.net/`，页面应是 Coo `/pet`。

## 已知限制 / 未决项

- `tailscale serve` 只对 tailnet 内可见；公网需 `tailscale funnel`，本项目不使用。
- 依赖 `tailscale serve` 对 WebSocket 的反代；`/socket` 双向协议需在真实 tailnet 设备上验证。
- 尚未在真实第二台设备上做端到端验收。
