# Absolute Solver Host

Windows Tauri v2 tray MVP for local Host presence policy. It starts manually, stays hidden in the system tray, and defaults to `notify`.

Build from this directory with `cargo tauri dev` after installing the Tauri v2 CLI and Windows WebView2 prerequisites. The production bundle is an NSIS installer. No autostart entry is installed.

The host's stable ID and policy are stored under the OS application config directory in `host.json`. `appear` is an explicit local opt-in. A fullscreen overlay is shown only after a server `presence.grant` for `presence:show`, and it includes an immediate revoke action and a local TTL timer.

The app does not enable microphone, camera, files, clipboard, terminal, or robot motion. The only advertised device capability is `host_presence` with a display overlay.
