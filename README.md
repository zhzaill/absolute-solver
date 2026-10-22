# Absolute Solver

Absolute Solver is a server-authoritative voice runtime for one persistent AI mind with multiple thin bodies.

The Hub owns turns, body routing, permissions, model adapters, memory, and observability. Bodies capture audio, play responses, render subtitles or cues, and report capabilities. A body never owns the session.

## Status

- Protocol: **v1** with optional PCM16 binary media
- Crate version: **0.2.1**
- Runtime: Rust 2021, Tokio, Axum WebSocket
- Deployment target: trusted LAN; authentication is not implemented yet
- Display layer: optional Host Panel or Live2D prototype; Live2D is not required by the protocol

## Architecture

```text
Body / Host Panel ── WebSocket v1 ──┐
                                    ▼
                               Absolute Solver Hub
                         ┌──────────┼──────────┐
                         ▼          ▼          ▼
                       ASR        LLM/TTS    Memory
                         │          │          │
                         └──── Cortico adapter ──────┘
```

- **Hub**: authoritative turn state, body registry, active-body routing, adapters, memory, and trace.
- **Body**: audio capture/playback, local interruption, rendering, and bounded reconnect buffering.
- **Cortico integration**: external events enter through a controlled World adapter; Persona expressions return to Hub TTS.
- **Host Panel**: user-initiated local body presence using a one-time ticket.
- **Active body**: exactly one body receives `say` and `render.cue`; other connected bodies remain standby.

## Protocol

The public contract is versioned independently from the application release. A canonical v1 frame is:

```json
{
  "v": 1,
  "type": "speech.start",
  "at_ms": 12345
}
```

- [Protocol specification](docs/protocol.md)
- [North star and integration rules](docs/north-star.md)
- [Generated v1 wire schema](schemas/absolute-solver.wire.v1.schema.json)
- [Generated v1 state schema](schemas/absolute-solver.state.v1.schema.json)
- [Schema manifest](schemas/absolute-solver.v1.manifest.json)

Legacy frames without `v` are accepted as v1, but published clients should always send it. Breaking protocol changes require a new major version.

Generate schemas with:

```powershell
cargo run --bin absolute-solver-protocol-schema -- schemas
```

## Implemented

- Versioned WebSocket envelopes with legacy v1 fallback.
- `hello`, `audio.up`, `speech.start`, `speech.end`, `say`, `render.cue`, and `body.handoff`.
- Targeted `turn.started` and structured `protocol.error` control frames.
- Binary PCM16 media for clients that advertise `media: ["pcm16-binary"]`.
- Host Panel microphone capture with local VAD, pre-roll, half-duplex playback gating, and binary uplink.
- Turn-scoped PCM16 audio aggregation and stale-turn rejection.
- OpenAI-compatible ASR, chat, and TTS adapters.
- Subtitle-only degradation when a model service is unavailable.
- SQLite + FTS5 memory with recent-memory fallback.
- Active-body selection, standby state, disconnect fallback, and one-time Host Panel tickets.
- HTTP state, monitor, adapter, memory, and Cortico event endpoints.
- JSONL trace with metadata-only audio logging.

## Build And Test

```powershell
cargo fmt --check
cargo test
cargo build --release
```

The two main binaries are:

- `absolute-solver-hub`
- `absolute-solver-body`

## Configuration

Core environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `SOLVER_HUB_LISTEN` | `0.0.0.0:18100` | Hub listen address |
| `SOLVER_TRACE` | `trace/absolute-solver.jsonl` | JSONL trace path |
| `SOLVER_MEMORY_DB` | `data/absolute-solver-memory.sqlite3` | SQLite memory path |
| `SOLVER_ASR_URL` | `http://127.0.0.1:9881` | OpenAI-compatible transcription endpoint |
| `SOLVER_TTS_URL` | `http://127.0.0.1:18080` | OpenAI-compatible speech endpoint |
| `SOLVER_LLM_URL` | empty | OpenAI-compatible chat endpoint |
| `SOLVER_LLM_MODEL` | empty | Chat model name |
| `SOLVER_LLM_API_KEY` | empty | Optional bearer token; never commit it |
| `SOLVER_HOST_PANEL_URL` | `http://127.0.0.1:5274/` | Local Host Panel redirect target |
| `SOLVER_HOST_WS_URL` | `ws://127.0.0.1:18100/ws` | WebSocket URL embedded in Host Panel invites |

Additional model timeout and budget variables are documented in [docs/protocol.md](docs/protocol.md) where they affect observable behavior.

## Security

This release is intended for a trusted LAN.

- Hub APIs have no authentication.
- Host access is user-initiated and uses a one-time ticket.
- Host tickets are removed from public monitor capabilities before registration is reported.
- Audio payloads are never written to trace or monitor snapshots.
- Do not expose the Hub directly to the public internet.

## Known Limits

- The binary media plane currently supports PCM16 audio only; camera/video is not implemented.
- Audio is not streamed sentence-by-sentence yet.
- Browser microphone capture and local VAD exist; persistent native-device playback queues are still in progress.
- Camera/perception ingress and capability-scoped host permissions are not implemented.
- Multi-body handoff currently selects one active output body but does not coordinate playback drain across devices.

## Repository Layout

```text
src/wire.rs                    Protocol types and compatibility rules
src/bin/hub.rs                 Authoritative runtime
src/bin/body.rs                Deterministic body client
src/bin/protocol_schema.rs     Schema generator
docs/protocol.md               Public protocol contract
schemas/                       Generated versioned schemas
tools/                         Smoke tests and local adapters
body-panel/                    Thin Host Panel implementation
```
