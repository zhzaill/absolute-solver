# Host Projection

`host-projection.mjs` runs independently of Hub and Body. It serves a read-only LAN directory at `/` and its current status at `/api/services`.

```powershell
$env:SOLVER_PROJECTION_CONFIG = 'C:\path\to\host-projection.json'
node tools/host-projection.mjs
```

Copy `host-projection.example.json` to a local config, then set the actual Host address and services for that machine. A gitignored `host-projection.local.json` is used automatically when present. The sample only lists the known Cortico World, ASR, LLM, and TTS endpoints; an endpoint is shown online only after its health request succeeds. Unknown versions stay `unknown`. Credentials, query parameters, and fragments are removed from displayed URLs. Loopback interfaces are never linked to from a remote browser.

The directory binds to `0.0.0.0:18111` by default and is unauthenticated, so use it only on a trusted LAN. The root route is the original Coo `/pet` page through a same-origin proxy; its menu, typing, voice input, bubbles, actions, and `/socket` protocol remain Coo's own UI and runtime. `/services` is the separate read-only health directory. New Coo `tts.voice` audio attachments are exposed only through the projection's polling/audio routes so the current LAN browser can play them; Coo Host `audio-play` may continue playing locally. The proxy preserves Coo's sandbox `Origin: null` asset access and rewrites only the CSP sources needed for the same-origin page. It does not expose the Cortico management console, Hub `/app`, credentials, or private event bodies.

Run the focused checks with `node --test tools/host-projection.test.mjs`.

The WebSocket proxy uses the `ws` dependency declared in `tools/package.json`; run `npm install --prefix tools` once on a Host before starting the full three-view page.

## Cortico World

The npm package is being updated to `cortico-world-absolute-solver@0.2.1`. It exposes the configured projection root to Cortico as World `absolute-solver`. Its Cortico API 6 `webUi()` page shows links for the current Coo projection page and the derived `/services` directory; its environment prompt includes the same usage guidance. Enable it in `worlds.absolute-solver` and call `solver_services` when a fresh read-only snapshot is needed. Verify registry availability before updating an installed extension; the npm publish request can be accepted for processing before the version is installable.
