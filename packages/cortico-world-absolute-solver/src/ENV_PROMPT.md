Absolute Solver Host 投影为同一可信局域网提供 Coo 原生桌宠页面和只读服务目录。

当前投影网页：{{absolute-solver.projectionUrl}}
只读服务目录：{{absolute-solver.directoryUrl}}
当前目录状态：{{absolute-solver.status}}

使用方式：
- 用户要打开 Coo 桌宠、原生菜单、打字交互、气泡或动作时，提供“当前投影网页”链接。
- 用户要查看 Cortico/Coo、ASR、LLM、TTS 等服务是否在线时，提供“只读服务目录”链接；需要刷新实际状态时调用 `solver_services`。
- 投影网页复用 Coo 原有交互和 TTS；LAN 浏览器的声音由打开该网页的设备播放。普通 HTTP LAN 地址不满足浏览器麦克风安全上下文要求，语音采集需 HTTPS 且设备信任证书。

目录中的在线状态来自服务健康请求；Host 在线、服务在线和用户授权是不同事实。这个 World 只提供网页入口、使用说明和服务发现，不授予访问权限，不执行插件动作，不替代 Hub、Body 或 Coo 的运行时。
