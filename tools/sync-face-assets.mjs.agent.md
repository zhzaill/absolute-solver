# sync-face-assets.mjs — 交接说明

## 用途 / 入口

把 Coo 已安装的 Live2D 图包、桌宠 kit 和官方模型转换器复制到 `tools/face/`，让主界面不依赖 Coo 的运行时路径。

```powershell
node tools/sync-face-assets.mjs
```

可重复执行（幂等，先删目标再拷）。

## 复制内容

| 源（默认 `D:\11\Tools\coo`，可 `COO_HOME` 覆盖） | 目标 | 排除 |
|---|---|---|
| `data/home/companion/data/figures/deepseek` | `tools/face/live2d/pack` | `models/deepseek/moc3.js`（22 MB base64 回退）、`native-library.json`、`thumb` |
| `resources/app/node_modules/cortico-world-desktop-pet/web/kit` | `tools/face/live2d/kit` | — |
| `data/extensions/node_modules/cortico-world-figure/workbench/tools` | `tools/face/import` | `workbench`、`native-catalog.mjs`、`shrink-textures.py` |

复制后校验关键文件存在：`figure.js`、`backends/live2d.js`、`sdk/live2dcubismcore.min.js`、`models/index.js`、`model.moc3`、`profile.js`、贴图、`kit/body.js|rig.js`。缺任一则退出码 1。

## 前置条件与依赖

- 本机已安装 Coo（Electron 应用目录 `D:\11\Tools\coo`）。
- 只用 Node 内置模块。

## 输入 / 输出与影响范围

- 只写 `tools/face/live2d/` 与 `tools/face/import/`（已 gitignore）。
- 不改 Coo 安装目录；同步是单向后覆盖。
- `moc3.js` 被排除是因为运行时优先 `fetch(model.moc3)`，HTTPS 同源下不需要 base64 回退。

## 验证

```powershell
node tools/sync-face-assets.mjs
dir tools\face\live2d\pack\models\deepseek
dir tools\face\import
```

## 已知限制 / 未决项

- Coo 升级后图包格式可能变化，需重跑同步并在浏览器复核。
- 只同步 deepseek 一个图包；换默认模型要同时改 `models.json` 的 `root`。
- 转换器 `convert.mjs` 来自 Coo 扩展，未修改；其依赖的 `parameter-mapping.mjs` 已一并复制。
