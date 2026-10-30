# cortico-world-absolute-solver

给 Cortico/Coo 加一个局域网入口：复用 Coo 原版“大肥鱼”桌宠页面、读取服务状态，并在目标 Host 本地确认后让 Coo 短时串门。

这个 World 不重画桌宠，不另做聊天框，也不替换 Coo 的 Persona。打开链接后看到的是 Coo 原版“大肥鱼”桌宠页面；对话、动作、TTS 和播放仍由 Coo 自己处理。

## 安装

在 Cortico/Coo 的扩展市场搜索 `cortico-world-absolute-solver`，或在扩展目录执行：

```powershell
pnpm add cortico-world-absolute-solver
```

安装后启用 `worlds.absolute-solver`，只需要填一个投影入口：

```json
{
  "worlds": {
    "absolute-solver": {
      "enabled": true,
      "directoryUrl": "http://192.168.1.178:18111",
      "projectionHubUrl": "http://192.168.1.166:18100",
      "projectionTargetHostId": "solver-server",
      "projectionSourceInstance": "coo-local"
    }
  }
}
```

把地址换成运行 `tools/host-projection.mjs` 的那台电脑的局域网地址。不要填 `127.0.0.1`，手机或另一台电脑看不到它。

## 使用

启用后，Cortico 会看到服务目录、访问许可和投影工具：

- **当前投影网页**：打开 Coo 原版桌宠、对话、菜单和动作。
- **服务目录**：打开 `${directoryUrl}/services`，查看 Coo、TTS、ASR、LLM 等服务状态。
- `solver_request_visit`：向配置的目标 Host 请求一次 Coo 原生页面串门；目标机器本地点击允许后才打开。
- `solver_environment`：读取当前 `local/remote` 位置、Host 在线状态、底部显示和声音输出事实。
- `solver_return_visit`：结束租约并请求回到本机。

声音走 Coo 原版链路：`tts` 生成 `tts.voice`，`audio-play` 在运行 Coo 的本机扬声器播放；这个 World 不拿密钥、不转发音频，也不复制 TTS。

## 启动投影网页

在 Absolute Solver 仓库目录运行：

```powershell
node tools/host-projection.mjs
```

默认监听 `0.0.0.0:18111`。在浏览器打开：

```text
http://这台电脑的局域网地址:18111/
```

第一次播放前，在页面点一下或按一下键解锁浏览器声音。手机可以播放已有语音；原版麦克风输入需要 HTTPS。

## 二阶段访问许可

本包还提供 `solver_request_access` 和 `solver_access_status`，用于一次性的 TTS/ASR 跨主机访问请求。请求必须由目标机器本地用户确认；本包不会接收 grant、API key 或完整音频。未配置 Hub 时，普通投影和服务目录仍可使用。

## 三阶段 Coo 串门

`solver_request_visit` 只提出固定的 `coo-pet`、屏幕底部、远端声音请求，不接受 URL、命令或浏览器参数。服务器 Host 打开的是 Coo 原生 `/pet`，不启动第二个 Coo。Cortico 读取 `solver_environment` 后才知道当前是否在 `192.168.1.166`；Host-online 事实不会自动替 Persona 决定。

串门期间 World 调用 Cortico 原生 WebUI 隐藏本机桌宠，并临时关闭本机 `audio-play` 的自动播放，保存原设置；返回、过期、撤销或断线后恢复。若本机控制接口不可用，环境结果会包含 `local_output.lastError`，不会伪报隐藏或静音成功。

## 不工作时先看三件事

1. `directoryUrl` 是否是运行投影电脑的局域网地址，而不是 `127.0.0.1`。
2. `http://服务器地址:18080/healthz` 是否返回 `"ok":true`。
3. Cortico 的 World 状态里，`tts` 是否 online、`audio-play` 是否显示“本机扬声器”。

## 版本与证据

当前包版本为 `0.3.1`。它复用 Coo 原版桌宠运行时，不复制 renderer、Persona 或聊天界面。项目状态与验收证据见 Absolute Solver 仓库的 `docs/ABSOLUTE_SOLVER_CURRENT_STATE.md` 和 `D:\11\Logs`。
