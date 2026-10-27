# 任务卡：TTS 服务降级为 OpenAI 远程服务（局域网共享）

- 日期：2026-10-27（Asia/Shanghai）
- 状态：`accepted`（服务端 + Hub 侧均已落地并实跑验证）
- 相关文档：`docs/TTS_REQUIREMENTS.md` §0.2、§3、§7；报告 `D:\11\Logs\2026-10-27-tts-openai-remote-service.md`

## 1. 目标

把原本绑在回环地址、只服务本机 Hub 的 TTS 网关，降级成一个**标准的 OpenAI 形态远程服务**：

1. 在服务器上启动，绑定 `0.0.0.0:18080`，通过 API 分享到局域网；
2. 拥有浏览器**配置界面**（音色、密钥、设置、上游、试听、示例）；
3. 客户端用 `sk-` 密钥调用，配置界面用独立管理员口令；
4. Hub 侧退化为纯 OpenAI 远程客户端，不再携带任何 GPT-SoVITS 专有字段。

## 2. 范围

| 层 | 改动 |
|---|---|
| 服务端 | `gateway.py` 重写为 v2.0.0：OpenAI 接口 + 管理 API + 静态界面；新增 `ui/`（index.html/app.css/app.js）、`provision.py`、`run-tts-service.ps1/.cmd`、`README.md` |
| 服务端 | `config.json` 取代 `gateway_state.json`（首次启动自动迁移音色）；新增多客户端密钥、管理员口令哈希、会话签名密钥 |
| 服务端 | Windows 防火墙入站规则 `TTS Service 18080`；计划任务 `Absolute-Solver-TTS` 改走新的启动器（退出码 75 自动重启） |
| Hub | `src/adapters.rs`：`synthesize` 只发 `model/input/voice/response_format`，新增 `SOLVER_TTS_API_KEY` → `Authorization: Bearer`；删除 `tts_text_lang`/`tts_prompt_lang` |
| Hub | `src/bin/hub.rs`：`monitor.json` 移除 `tts_text_lang`/`tts_prompt_lang`；测试夹具同步 |
| 部署 | 服务器 `E:\Absolute-Solver\`：新二进制（SHA256 `B76CB796…C8`）+ `run-hub-v0.2.1.cmd` 增加密钥、删除语言变量 |

## 3. 非目标

- 不做 Provider 侧流式 PCM（`2026-10-26-tts-streaming-pcm` 仍为 blocked，本任务不宣称流式）；
- 不做 HTTPS/TLS 与公网映射；
- 不改 GPT-SoVITS 上游本体，也不让客户端直连 `9880`；
- 不做 DSH `dsh-tts` 插件的自动重配（只提供密钥与示例）。

## 4. 验收项

| # | 验收 | 结果 |
|---|---|---|
| 1 | 服务在服务器 `0.0.0.0:18080` 启动，上游 `9880` 仍为回环 | 通过 |
| 2 | 局域网 `GET /healthz` 返回 200 且 `upstream_alive=true` | 通过 |
| 3 | 无密钥/错密钥 `POST /v1/audio/speech` → 401 | 通过 |
| 4 | 正确密钥 → 200，返回 RIFF/WAV，带 `x-tts-ms` | 通过（185,644 B / 1,729 ms） |
| 5 | 配置界面 `/admin` 可登录，页面可操作 | 通过（浏览器实测 5 个页面，明暗两套主题） |
| 6 | 客户端密钥与管理员口令权限分离 | 通过（Cookie 写操作缺自定义头 → 403） |
| 7 | 音色表迁移完整 | 通过（12 个音色，默认 `furina_normal`） |
| 8 | 界面「重启服务」由启动器拉起 | 通过（uptime 从 293 s 归零到 6 s） |
| 9 | Hub 以纯 OpenAI 形态合成成功 | 通过（`tts_ok=1`，250,880 B PCM16，2,008 ms） |
| 10 | 代码与测试 | 通过（本地冒烟 33 项；`cargo fmt`；`cargo test` 42+12+23） |

## 5. 产物

- 服务代码：`D:\11\Projects\absolute-solver-tts\gateway\`（`gateway.py`、`ui/`、`provision.py`、`run-tts-service.*`、`README.md`）
- Hub 代码：`D:\11\Projects\Absolute Solver\src\adapters.rs`、`src\bin\hub.rs`
- 服务器：`E:\GPT-SoVITS\gateway\`（含 `config.json`）、`E:\Absolute-Solver\absolute-solver-hub-v0.2.1.exe`
- 报告：`D:\11\Logs\2026-10-27-tts-openai-remote-service.md`

## 6. 回滚

1. 服务：`Copy-Item E:\GPT-SoVITS\gateway\gateway.py.pre-v2-20261027-214444.bak gateway.py`，恢复 `run-absolute-solver-gateway.cmd.pre-v2-20261027-214444.bak`，重启计划任务；防火墙规则可删除。
2. Hub：`absolute-solver-hub-v0.2.1.exe.pre-ttsv2-20261027-214655.bak` + `run-hub-v0.2.1.cmd.pre-ttsv2-20261027-214655.bak`，重启计划任务。
3. 注意：旧网关无鉴权，回滚等于局域网内无密钥可调用，只应在排查时短暂使用。

## 7. 未决

1. 验收时没有 active Body，音频"实际出声"未复验（合成链路已验）；接上 Body 后需补一次端到端听音。
2. 本机 DSH `dsh-tts` 插件仍指 `127.0.0.1:18080` 且无密钥，需要 `DSH_TTS_BASE_URL` / `DSH_TTS_API_KEY`（本次会话未加载该插件）。
3. 管理员口令与两把密钥记录在会话与凭据文件中，未写入本卡。
4. 传输为明文 HTTP，防火墙不限网段，按运营决定执行。
