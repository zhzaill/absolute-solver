# Absolute Solver

让同一个 Cortico/Coo 桌宠出现在你的电脑、手机、浏览器和树莓派上。你只需要打开一个局域网网址；桌宠页面、对话、动作和声音仍然由 Coo 原版服务提供，Absolute Solver 负责把设备连接起来。

## 先看能不能用

这是一个给自有设备使用的可信局域网项目，不是公网 SaaS。最简单的可用组合是：

- 一台电脑运行 Cortico/Coo；
- 一台电脑运行 Absolute Solver Hub 和 TTS；
- 两台设备在同一个局域网；
- Coo 的 `tts` 和 `audio-play` World 已启用。

## 五分钟试用

1. 在服务器确认 TTS：打开 `http://服务器地址:18080/healthz`，看到 `"ok":true`。
2. 在运行 Coo 的电脑启动投影入口：

   ```powershell
   node tools/host-projection.mjs
   ```

3. 在同一台电脑或手机打开：

   ```text
   http://运行Coo的电脑地址:18111/
   ```

4. 页面就是 Coo 原版桌宠页面。点桌宠的对话按钮，输入一句话；Coo 的原版 TTS 会生成 `tts.voice`，`audio-play` 会在运行 Coo 的这台设备上播放。

5. 查看服务是否在线：打开同一地址的 `/services`。

第一次播放前，先在页面点一下或按一下键，让浏览器解锁声音。手机浏览器可以播放声音；原版语音输入需要 HTTPS，普通 HTTP 局域网地址不能申请麦克风。

## 这套东西负责什么

- **Coo/Cortico**：Persona、对话、记忆、桌宠形象、动作、TTS 语义和插件。
- **Hub**：设备连接、回合、音频路由、一次性访问许可和运行事实。
- **Body/投影页面**：播放声音、显示 Coo、报告设备状态。
- **服务目录**：只读展示 Cortico、Coo、TTS、ASR、LLM 等真实服务状态。

投影层不重画大肥鱼，不复制 Coo 的聊天框、动作词表或 Persona。打开网页看到的就是 Coo 原版桌宠。

## 二阶段访问许可

仓库里的 `access.*`、Host Agent 和 `cortico-world-absolute-solver` 已通过自动化测试。真实跨主机 TTS/ASR 仍需要目标机器前的人点击一次 Allow，因此当前不能称为生产验收通过，也不会自动替换你现在已经能用的直连 TTS。

想先自己检查访问许可合同，双击 `tools/stage2-rehearse.cmd`。它只使用本机临时模拟服务，不会连接生产 Hub、服务器或 TTS。

## 常见问题

**页面能开但没有声音**

在运行 Coo 的电脑确认 `audio-play` 为 active、播放后端为 Windows WPF MediaPlayer，并在页面先点一下。再看 Cortico 的 World 状态：`tts` 应显示 online，`audio-play` 应显示本机扬声器 online。

**服务器刚睡醒，TTS 不响应**

先访问 `/healthz`。如果不是 `"ok":true`，重启服务器上的 TTS 上游和网关任务，再等待模型加载完成；第一次合成可能需要几十秒。

**手机能看但不能录音**

这是浏览器安全规则。给投影入口配置 HTTPS 并让手机信任证书，或者先用 Coo 本机桌面窗口输入文字。

## 开发与验证

需要 Rust stable 和 Node 22：

```powershell
cargo fmt --check
cargo test
node --test tools/*.test.mjs packages/cortico-world-absolute-solver/test/world.test.mjs
```

权威状态见 [当前可信项目现状](docs/ABSOLUTE_SOLVER_CURRENT_STATE.md)，原始运行证据在 `D:\11\Logs`。不要把 Hub 暴露到公网，也不要把 API key、token 或服务器密码提交到仓库。
