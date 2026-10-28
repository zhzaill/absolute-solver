# cortico-world-absolute-solver

让 Cortico/Coo 以一个 World 展示 Absolute Solver 当前投影网页、提供使用说明，并读取局域网服务目录。

## 安装

```powershell
pnpm add cortico-world-absolute-solver
```

在 Cortico 配置中启用 `worlds.absolute-solver`，把 `directoryUrl` 设为运行投影服务的局域网根地址，例如 `http://192.168.1.178:18111`。

World 控制台显示两个入口：

- **打开当前投影网页**：根地址，直接使用 Coo 原版桌宠页面、菜单、打字交互、气泡和动作。
- **打开服务目录**：`${directoryUrl}/services`，查看 Cortico/Coo、ASR、LLM、TTS 等服务的实际健康状态。

World 环境提示会向 Persona 提供当前两个地址、最近目录状态和简要使用说明。需要刷新服务状态时调用 `solver_services`。

投影网页中的 Coo TTS 音频由当前打开页面的浏览器消费。普通 HTTP LAN 地址不提供浏览器麦克风 API；要用原版语音采集，需配置 HTTPS，且客户端设备必须信任证书。桌宠、Persona、会话、工具和 TTS 合成仍由 Coo/Cortico 原服务负责。

本 World 只展示入口、说明和服务发现；不授予网络权限、不执行插件动作，也不复制 Coo 桌宠 renderer。

启动 Absolute Solver 目录：

```powershell
node tools/host-projection.mjs
```

本机目录默认监听 `0.0.0.0:18111`。实际根地址取运行 Host 的 LAN 地址。比如 `http://192.168.1.178:18111/` 是当前投影网页，`http://192.168.1.178:18111/services` 是服务目录。
