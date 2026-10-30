# cortico-world-absolute-solver

给 Cortico/Coo 加一个很简单的入口：告诉桌宠当前 Absolute Solver 投影网页在哪里，以及局域网里的服务是否在线。

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
      "directoryUrl": "http://192.168.1.178:18111"
    }
  }
}
```

把地址换成运行 `tools/host-projection.mjs` 的那台电脑的局域网地址。不要填 `127.0.0.1`，手机或另一台电脑看不到它。

## 使用

启用后，Cortico 会看到两个入口：

- **当前投影网页**：打开 Coo 原版桌宠、对话、菜单和动作。
- **服务目录**：打开 `${directoryUrl}/services`，查看 Coo、TTS、ASR、LLM 等服务状态。

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

## 不工作时先看三件事

1. `directoryUrl` 是否是运行投影电脑的局域网地址，而不是 `127.0.0.1`。
2. `http://服务器地址:18080/healthz` 是否返回 `"ok":true`。
3. Cortico 的 World 状态里，`tts` 是否 online、`audio-play` 是否显示“本机扬声器”。

## 版本与证据

当前包版本为 `0.3.0`。它只提供网页入口、服务发现和访问请求，不改变 Coo 原版桌宠运行时。项目状态与验收证据见 Absolute Solver 仓库的 `docs/ABSOLUTE_SOLVER_CURRENT_STATE.md` 和 `D:\11\Logs`。
