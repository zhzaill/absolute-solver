# face-window.mjs — 交接说明

## 用途 / 入口

**可选**的桌面悬浮窗宿主：把 `/figure` 放进一个透明、无边框、置顶、默认鼠标穿透的窗口，做出"桌宠浮在桌面上"的效果。**主线仍然是网页界面**，这个只是可选形态。

```powershell
node tools/face-window.mjs                       # 默认 420x760，右下角
node tools/face-window.mjs --size 520x900
node tools/face-window.mjs --url http://192.168.67.178:18111/figure
```

快捷键：`Ctrl+Shift+F` 切换鼠标穿透/可交互（可交互时整块区域就是拖动把手），`Esc` 关窗，`Ctrl+Shift+Q` 退出。

## 结构

- `tools/face-window.mjs`：启动器，解析 `electron` 路径并 spawn。
- `tools/face-window/package.json` + `main.cjs`：Electron 应用（`frame:false`、`transparent:true`、`alwaysOnTop('screen-saver')`、`setIgnoreMouseEvents(true,{forward:true})`）。
- `node_modules/`、`package-lock.json` 已 gitignore。

## 前置条件与依赖

- 需要 `tools/face-window/node_modules/electron`。安装：
  ```powershell
  cd "D:\11\Projects\Absolute Solver\tools\face-window"
  npm install --save-dev electron --no-audit --no-fund
  ```
  若 GitHub 下载失败（国内常见），用镜像重跑：
  ```powershell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  node node_modules/electron/install.js
  ```
- 投影服务必须先起来（默认 `http://127.0.0.1:18111/figure`）。

## 输入 / 输出与影响范围

- 只读 `/figure` 页面；不改任何文件；不持有密钥。
- 窗口透明 + 置顶；默认穿透，不会挡住桌面点击。
- 启动器会清掉环境里的 `ELECTRON_RUN_AS_NODE`（否则 Electron 退化成 Node，`app` 为 undefined）。

## 验证

```powershell
node tools/face-window.mjs
# 应看到右下角出现只有人物、无边框的窗口
```

## 已知限制 / 未决项

- Windows 透明窗口在部分显卡/缩放比例下边缘可能有轻微残影。
- 未做托盘图标与开机自启；需要时再补。
- 只宿主 `/figure`；要宿主对话页请用 `--url .../`（会失去透明意义）。
- 尚未在非 Windows 平台验证。
