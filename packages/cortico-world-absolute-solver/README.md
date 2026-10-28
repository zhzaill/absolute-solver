# cortico-world-absolute-solver

让 Cortico/Coo 以一个 World 读取 Absolute Solver 的局域网服务目录。

## 安装

```powershell
pnpm add cortico-world-absolute-solver
```

在 Cortico 配置中启用 `worlds.absolute-solver`，把 `directoryUrl` 设为运行投影服务的局域网地址，例如 `http://192.168.1.178:18111`。

World 提供 `solver_services` 只读工具和一个控制台入口。它只报告服务发现与健康状态；不授予网络权限、不执行插件、不代理音频，也不替代 Coo 的桌宠 renderer。

启动 Absolute Solver 目录：

```powershell
node tools/host-projection.mjs
```

本机目录默认监听 `0.0.0.0:18111`。实际地址取运行 Host 的 LAN 地址。
