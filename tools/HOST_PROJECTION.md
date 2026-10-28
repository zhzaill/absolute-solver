# Host Projection

`host-projection.mjs` runs independently of Hub and Body. It serves a read-only LAN directory at `/` and its current status at `/api/services`.

```powershell
$env:SOLVER_PROJECTION_CONFIG = 'C:\path\to\host-projection.json'
node tools/host-projection.mjs
```

Copy `host-projection.example.json` to a local config, then set the actual Host address and services for that machine. The sample only lists the known Cortico World, ASR, LLM, and TTS endpoints; an endpoint is shown online only after its health request succeeds. Unknown versions stay `unknown`. Credentials, query parameters, and fragments are removed from displayed URLs. Loopback interfaces are never linked to from a remote browser.

The directory binds to `0.0.0.0:18111` by default and is unauthenticated, so use it only on a trusted LAN. It supports only `GET` and `HEAD`. It does not proxy service traffic or execute service actions. Coo's `/pet` remains loopback-only until a projection path can preserve its original renderer while preventing a LAN viewer from becoming a command-capable pet client.

Run the focused checks with `node --test tools/host-projection.test.mjs`.

## Cortico World

The npm package `cortico-world-absolute-solver@0.1.0` exposes the configured directory to Cortico as World `absolute-solver`. Enable it in `worlds.absolute-solver` and call `solver_services` when a fresh read-only snapshot is needed.
