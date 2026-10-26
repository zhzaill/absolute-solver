# Absolute Solver Protocol v1

## Scope

This document defines the WebSocket and HTTP contracts used by an Absolute Solver Hub, body, Host Panel, and external World adapter.

The Hub is authoritative. A body reports facts and capabilities; it does not create turns or decide which body owns the current response.

## Versioning

- `v` is the protocol major version.
- Current version: `v = 1`.
- Additive fields and message types may be introduced without changing `v`.
- Removing fields, changing existing semantics, or requiring incompatible behavior requires a new major version.
- Clients must ignore unknown fields.
- The Hub rejects unknown major versions.
- Legacy unversioned client frames are treated as v1 for the initial migration window.
- New clients must send `v: 1` on every frame.

Generated schemas:

- `schemas/absolute-solver.wire.v1.schema.json`
- `schemas/absolute-solver.state.v1.schema.json`
- `schemas/absolute-solver.v1.manifest.json`

The Rust types in `src/wire.rs` are the source of truth. Generated schemas must be updated in the same change as protocol types.

## Transport

- WebSocket endpoint: `/ws`
- Application frames: UTF-8 JSON text
- WebSocket ping/pong: standard control frames
- State endpoint: `GET /state`
- Turn trace: `GET /turn/{turn}`
- Monitor snapshot: `GET /monitor.json`
- Adapter probe: `GET /adapters`

JSON media uses base64 PCM16 for compatibility. A body that advertises `media: ["pcm16-binary"]` may use the optional v1 binary media frame described below instead. WebRTC is outside v1.

## Envelope

```json
{
  "v": 1,
  "message_id": "optional-client-id",
  "type": "audio.up",
  "turn": 12,
  "seq": 4,
  "pcm_b64": "...",
  "sr": 16000
}
```

Fields:

| Field | Required | Meaning |
|---|---|---|
| `v` | yes for new clients | Protocol major version |
| `message_id` | no | Client correlation identifier; preserved as a wire field but not yet used for acknowledgement |
| `type` | yes | Message type |

Unknown fields are reserved for forward compatibility.

## Message Directions

| Type | Direction | Purpose |
|---|---|---|
| `hello` | body → Hub | Register device identity and capabilities |
| `audio.up` | body → Hub | Append one PCM16 audio chunk to a turn |
| `speech.start` | body → Hub | User started speaking; interrupt current output |
| `speech.end` | body → Hub | Finalize one utterance and start the Hub pipeline |
| `say` | Hub → active body | Final response text, PCM16 audio, and mouth timeline |
| `render.cue` | Hub → active body | Subtitle/expression/motion cue |
| `body.handoff` | Hub → all bodies | Announce the current active body |
| `turn.started` | Hub → requesting body | Return the authoritative turn allocated after `speech.start` |
| `protocol.error` | Hub → offending body | Structured validation or protocol error |

## Registration

`hello` must be the first application message.

```json
{
  "v": 1,
  "type": "hello",
  "device_id": "host-panel-a1b2c3",
  "caps": {
    "display": "host-panel",
    "speaker": true,
    "subtitle": true,
    "host_ticket": "optional-one-time-ticket"
  }
}
```

- `device_id` must be stable for a connection lifetime and should remain stable across normal reconnects.
- `caps` is an extensible object. Consumers must not reject unknown capability keys.
- `host_ticket` is consumed once, removed from monitor state, and replaced with `entry: "cortico"` when valid.

## Audio Input

```json
{
  "v": 1,
  "type": "audio.up",
  "turn": 12,
  "seq": 4,
  "pcm_b64": "...",
  "sr": 16000
}
```

- `turn`: body-created turn candidate; the Hub may promote or reject based on current state.
- `seq`: monotonically increasing within the turn.
- `sr`: sample rate, 8,000–96,000 Hz.
- `pcm_b64`: base64 of mono signed 16-bit little-endian PCM.
- The Hub caps accumulated audio at 5 MiB per turn.
- Stale turns are dropped.

`speech.start` increments the Hub turn and immediately invalidates older output.

The Hub responds only to the requesting connection with:

```json
{
  "v": 1,
  "type": "turn.started",
  "turn": 13
}
```

Clients that use local VAD should wait for `turn.started` before assigning binary audio frames to a turn. They may buffer a short pre-roll while waiting.

`speech.end` finalizes the current turn and starts ASR → LLM → TTS.

## Audio Output

```json
{
  "v": 1,
  "type": "say",
  "turn": 12,
  "seq": 0,
  "pcm_b64": "...",
  "sr": 32000,
  "mouth": [0.1, 0.4, 0.8],
  "text": "Final response text",
  "media": "pcm16-binary"
}
```

- `say` is delivered only to the active body.
- `sr` is the actual output sample rate returned by TTS.
- `mouth` is a normalized `0.0..=1.0` timeline derived from the PCM envelope.
- `text` is the canonical subtitle for the same turn.
- `media` is omitted for legacy base64 JSON audio.
- When `media` is `pcm16-binary`, `pcm_b64` is empty and exactly one binary `say.audio` frame follows the JSON frame with matching `turn` and `seq`.

### Segmented turns

A reply may be split into several `say` frames of one `turn`:

```json
{
  "v": 1,
  "type": "say",
  "turn": 12,
  "seq": 2,
  "pcm_b64": "",
  "sr": 32000,
  "mouth": [0.2, 0.6],
  "text": "Second sentence of the reply.",
  "media": "pcm16-binary",
  "seg_total": 4,
  "last": false
}
```

- `seq` is the segment index within the turn, starting at `0`.
- `seg_total` and `last` are optional and absent for a single-shot reply; they never
  change the meaning of existing fields.
- Bodies must play segments in `seq` order, drop a `seq` below the next expected
  one (duplicate or stale), and drop every segment of a turn older than the turn
  they are currently playing.
- A body that does not understand the two fields keeps working: it receives the
  frames in order and plays them sequentially.
- The Hub keeps one turn `Speaking` until the summed PCM duration of the sent
  segments elapses, then returns to `idle`.
- A segment that fails synthesis is replaced by a subtitle `render.cue`; the turn
  continues with the remaining segments. If the first segment fails, the whole
  reply degrades to subtitle-only.

## Binary Media

Binary frames are enabled only when the body advertises:

```json
{
  "caps": {
    "speaker": true,
    "media": ["pcm16-binary"]
  }
}
```

All integer fields use little-endian encoding.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | ASCII magic `ASV1` |
| 4 | 1 | Binary media version, currently `1` |
| 5 | 1 | Kind: `1 = audio.up`, `2 = say.audio` |
| 6 | 2 | Reserved, currently zero |
| 8 | 8 | Turn |
| 16 | 8 | Sequence |
| 24 | 4 | Sample rate |
| 28 | remaining | Mono signed PCM16 |

- `audio.up` uses the same turn and sequence semantics as JSON audio.
- `say.audio` matches the `turn` and `seq` of the preceding binary `say` metadata.
- Odd PCM16 lengths, invalid sample rates, unknown versions, and unknown kinds produce `protocol.error`.
- The legacy JSON path remains available and is used by clients that do not advertise binary media.

## Render Cues

```json
{
  "v": 1,
  "type": "render.cue",
  "turn": 12,
  "kind": "cue",
  "text": "Subtitle text",
  "expression": "F01",
  "motion": "Tap"
}
```

`render.cue` does not create a new Hub model turn. It is delivered only to the active body in v1.

## Active Body And Handoff

The Hub maintains one active output body.

- The first connected body becomes active.
- A later body receives a `body.handoff` frame describing the current active body but does not preempt it.
- `say` and `render.cue` are sent only to the active body.
- If the active body disconnects, the Hub selects another connected body deterministically.
- If no body remains, `active_body` is `null`.

Handoff notification:

```json
{
  "v": 1,
  "type": "body.handoff",
  "active_body": "host-panel-a1b2c3",
  "reason": "first_body"
}
```

Current reasons:

- `first_body`
- `body_joined`
- `active_body_disconnected`

Presence does not grant local filesystem, camera, microphone, or terminal permissions. Those permissions remain host-scoped and out of protocol v1.

## Hub State

`GET /state` returns:

```json
{
  "state": "idle",
  "turn": 12,
  "since_ms": 1234,
  "reason": "response timer elapsed"
}
```

States:

- `idle`
- `listening`
- `thinking`
- `speaking`
- `degraded`

`since_ms` is a process-local monotonic millisecond value. It is not wall-clock time.

## HTTP Integration Endpoints

### `/cortico/event`

Accepts versioned Persona and World events. Replay detection is scoped by `(session_id, source)`. `persona.expression` may reach TTS; ordinary World events are archived and do not start a Hub LLM turn.

### `/host/connect`

Creates a short-lived one-time Host Panel invite and redirects to the local panel.

### Host presence

Host presence requests are disabled unless the Hub is configured with both
`SOLVER_PRESENCE_TOKEN` and an explicit comma-separated `SOLVER_PRESENCE_HOSTS`
allowlist. These environment variables are service-side configuration and must
not be sent to a desktop client.

`POST /presence/intent` requires `Authorization: Bearer <service-token>` and a
JSON body:

```json
{
  "host_id": "desktop-a",
  "reason": "The operator requested a connection",
  "urgency": "normal",
  "requested_scopes": ["presence:notify", "presence:show"],
  "ttl_ms": 30000
}
```

Only allowlisted, connected Hosts advertising `host_presence: true` can receive
an intent. TTL is limited to 1-120 seconds. The Hub sends `presence.intent` only
to that Host. A Host responds with `presence.decision` and one of `reject`,
`notify`, or `appear`; `appear` consumes the one-time intent and creates a
`presence:show` lease. The Hub then sends `presence.grant` to that Host. The
Host's local policy must also explicitly allow appearance before showing an
overlay. No presence grant authorizes camera, microphone, files, or motion.

`POST /presence/revoke` uses the same service authorization and accepts
`{"host_id":"desktop-a","intent_id":"...","reason":"operator_revoke"}`.
An active lease expires at its original intent deadline; the Hub emits
`presence.revoke` on explicit revoke or expiry. Intent reasons are not copied
into trace records. Presence trace entries contain event, Host, scope, urgency,
decision, and timing metadata only.

The `presence.intent`, `presence.decision`, `presence.grant`, and
`presence.revoke` WebSocket messages are v1 messages and do not allocate a Hub
turn. Decisions and client revokes are accepted only from the connection whose
registered device ID matches `host_id`.

### Read-only Robotics World

The XuegerOS Body Adapter exposes `GET /v1/world` as a read-only projection of
bounded robot status, mapping/navigation health, and the latest YOLO
`VisionObservation`. `GET /v1/observations/latest` contains structured
detections only: normalized bounding boxes, class, confidence, frame sequence,
timestamp, camera state, frame age, dropped frames, inference latency, and
detection count. It never returns a JPEG reference or raw frame. Camera frames
and inference tensors are volatile memory only; stale or disconnected camera
state clears detections. VM and map health probes run independently, so a
sleeping or unreachable VM does not block a fresh camera observation.
`autonomous_motion_allowed` remains `false`.

Configure the Hub poll target with `SOLVER_ROBOTICS_WORLD_URL`, for example
`http://127.0.0.1:18110` when the adapter runs on the Hub host. If the adapter
runs elsewhere, bind it only to a trusted private interface and allow Hub access
through the host firewall.

### Memory

- `POST /memory/write`
- `GET /memory/search?q=...&limit=...`
- `DELETE /memory/{id}`

Memory payloads never enter trace notes or monitor snapshots.

## Errors And Compatibility

Malformed input produces a targeted frame:

```json
{
  "v": 1,
  "type": "protocol.error",
  "code": "invalid_binary_media",
  "message": "invalid binary media magic",
  "fatal": false
}
```

`fatal: true` means the Hub will close the connection after sending the error. Current codes include:

- `invalid_message`
- `unknown_type`
- `unsupported_version`
- `not_registered`
- `invalid_binary_media`
- `invalid_binary_kind`
- `invalid_audio`
- `audio_too_large`
- `stale_turn`
- `invalid_host_ticket`

Unknown message types are forward-compatible extensions, so they are reported with
`code: "unknown_type"`, `fatal: false`, and the connection stays open. A frame whose
`type` is known but whose fields are invalid is `invalid_message`, also non-fatal.
An unsupported major version is fatal. The generated wire schema validates the
known v1 message shapes and accepts an otherwise well-formed envelope with an
unrecognized string `type` as an extension; consumers must ignore such extensions
they do not implement. The Hub reports an unknown inbound type for observability
without closing the connection.

Clients should:

1. Send `hello` first.
2. Always include `v`.
3. Ignore unknown fields and capabilities.
4. Treat unknown message types as forward-compatible extensions: log and ignore
   them without dropping the connection. The Hub may report an inbound unknown
   type with a non-fatal `protocol.error` frame.
5. Avoid assuming that presence implies permission.

## Security

Protocol v1 assumes a trusted deployment boundary.

- No application-level authentication is implemented.
- Do not expose the Hub directly to the public internet.
- Host tickets are one-time and time-limited.
- Trace and monitor snapshots omit audio payloads and memory text.
- Never put credentials in protocol frames, trace notes, URLs, or logs.

## Generation

```powershell
cargo run --bin absolute-solver-protocol-schema -- schemas
```

CI should fail if regenerated schemas differ from committed files.
