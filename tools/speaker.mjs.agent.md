# speaker.mjs — 交接说明

## 用途 / 入口

按用途起停服务器上的 TTS（网关 + GPU 上游），给这块 8G 的 P104 腾显存。

- `node tools/speaker.mjs on`（或 `start`）：确保**网关**在，拉起**上游**并常驻。
- `node tools/speaker.mjs sleep`（或 `off` / `stop`）：停上游，释放 GPU（网关保留，它不占显存）。
- `node tools/speaker.mjs status`：看 gateway / upstream 状态、本机持有的 SSH pid、服务器上的上游进程。

用 Cortico 时 `on` 常驻；跑别的模型测试时 `sleep`。

**只管 TTS。** ASR 不在这里：ASR 属于设备/Cortico 侧，投影服务通过 `face.asrBaseUrl`（或 `SOLVER_ASR_BASE_URL`）指向它，可能是本机、服务器或远端设备，不要写死。

## 关键背景

- **两个进程都由长驻 SSH 持有**，SSH 进程就是开关：
  - 网关：`cmd /c "cd /d <GATEWAY_DIR> && <BASE>\runtime\python.exe -u gateway.py"`，监听 `0.0.0.0:18080`。
  - 上游：`cmd /c "cd /d <BASE> && runtime\python.exe -u api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS\configs\tts_infer.yaml"`，只监听 `127.0.0.1:9880`。
- **计划任务 `\Absolute-Solver-TTS` 不可靠**：2026-11-08 实测它拉起的 `gateway.py` 会卡死（进程在、工作集 19 MB、累计 CPU 0.078 s，十几分钟从不 bind 18080）；同一条命令走 SSH 前台约 40 秒就正常监听。
- 网关导入本身慢：`requests`+`uvicorn` ≈ 12.9 s，加 `fastapi` ≈ 21.7 s（服务器磁盘/杀软），所以 `ensureGateway()` 最多等 120 秒。
- 冷启动上游约 143 秒；显存占用约 2.6 GB。

## 前置条件与依赖

- `tools/host-projection.local.json` 里有 `device.host/user/identityFile`（默认 192.168.67.166 / zhzaill / `C:/Users/zhzaill/.ssh/id_loopros`），可用 `SPEAKER_HOST/USER/KEY/BASE/GATEWAY_DIR` 覆盖。
- 服务器上 `E:\GPT-SoVITS\GPT-SoVITS-v2pro-20250604-nvidia50` 为 BASE，网关目录 `E:\GPT-SoVITS\gateway`，模型 `xxx-e15.ckpt`。
- Node 18+（用 global fetch）。

## 输入 / 输出与影响范围

- 状态文件：`tools/.speaker-state.json`，字段 `{ gatewayPid, upstreamPid, gatewaySince, upstreamSince }`；旧的 `{ pid }` 仍会被当作 `upstreamPid` 读取。已 gitignore。
- 影响：`on` 占 GPU ~2.6–3.8 GB，上游冷启动 2–3 分钟，网关约 30–60 秒。
- 不写密钥；只用 `identityFile` 路径。不改服务器上的配置与计划任务。

## 验证

```powershell
node tools/speaker.mjs status   # gateway: ok / upstream: alive
node tools/speaker.mjs on       # upstream_alive: true
node tools/speaker.mjs sleep    # GPU 回落
curl http://192.168.67.166:18080/healthz
```

## 已知限制 / 未决项

- 长驻 SSH 依赖本机与服务器的连通；**本机重启或断网后需要重新 `on`**。
- 计划任务仍存在但不再由本工具触发；如需彻底移除，需单独确认。
- 若网关起不来，`on` 会在拉起上游前中止并打印状态，不会留下半套服务。
