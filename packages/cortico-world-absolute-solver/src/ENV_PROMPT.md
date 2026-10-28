这个 World 提供 Absolute Solver 的只读局域网服务目录。

目录地址：{{absolute-solver.directoryUrl}}
当前目录状态：{{absolute-solver.status}}

需要刷新实际服务状态时调用 `solver_services`。目录中的在线状态来自服务健康请求；Host 在线、服务在线和用户授权是不同事实。这个 World 只提供服务发现和状态观察，不授予访问权限，不执行插件动作，不替代 Hub、Body 或 Coo 的运行时。
