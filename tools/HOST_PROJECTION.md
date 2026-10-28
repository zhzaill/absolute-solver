# Host Projection

`host-projection.mjs` runs independently of Hub and Body. It serves a read-only LAN directory at `/` and its current status at `/api/services`.

```powershell
$env:SOLVER_PROJECTION_CONFIG = 'C:\path\to\host-projection.json'
node tools/host-projection.mjs
```

Copy `host-projection.example.json` to a local config, then set the actual Host address and services for that machine. A gitignored `host-projection.local.json` is used automatically when present. The sample only lists the known Cortico World, ASR, LLM, and TTS endpoints; an endpoint is shown online only after its health request succeeds. Unknown versions stay `unknown`. Credentials, query parameters, and fragments are removed from displayed URLs. Loopback interfaces are never linked to from a remote browser.

The directory binds to `0.0.0.0:18111` by default and is unauthenticated, so use it only on a trusted LAN. The same origin includes the Coo `/pet` renderer in observation mode, embeds Hub `/app` for conversation and TTS, and proxies Hub `/ws` for browser Body playback. Coo WebSocket client messages are dropped by the projection proxy; the page cannot issue Coo actions. The proxy preserves Coo's sandbox `Origin: null` asset access and rewrites only the CSP sources needed for the same-origin frame. It supports only the routes needed by these views and does not expose credentials or private event bodies.

Run the focused checks with `node --test tools/host-projection.test.mjs`.

The WebSocket proxy uses the `ws` dependency declared in `tools/package.json`; run `npm install --prefix tools` once on a Host before starting the full three-view page.

## Cortico World

The npm package `cortico-world-absolute-solver@0.1.0` exposes the configured directory to Cortico as World `absolute-solver`. Enable it in `worlds.absolute-solver` and call `solver_services` when a fresh read-only snapshot is needed.
