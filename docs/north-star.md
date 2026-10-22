# North Star And Integration Rules

## What We Want

Absolute Solver exists so one continuous mind can think on a server and appear through many small bodies.

The product outcome is:

- one identity and one memory stream;
- many bodies with different capabilities;
- thin devices that can capture, play, display, and interrupt without running the full AI stack;
- explicit, temporary, revocable host presence;
- a stable protocol that lets new worlds, tools, models, and devices integrate without redefining the core.

## Invariants

1. **Hub owns runtime truth.** Turns, body registration, active-body selection, audio routing, permissions, trace, and degradation belong to the Hub.
2. **Persona owns decisions.** Cortico or another Persona layer decides whether to speak, act, remain silent, or use a tool.
3. **Bodies own only local facts and I/O.** A body may preprocess signals, buffer briefly, render, play, and interrupt. It does not own session state.
4. **One active output body.** Other bodies may standby or mirror non-audio state. Audio output requires explicit handoff.
5. **Ingress is processed before cognition.** Device signals are normalized, deduplicated, bounded, routed, and annotated before reaching Persona context.
6. **Presence is not permission.** Being online never grants microphone, camera, screen, file, or terminal access. Each host grants scoped, revocable capabilities.
7. **Protocols are versioned.** Additive changes remain v1. Breaking changes require a new major version and migration notes.
8. **Logs are continuity.** Decisions, evidence, and unresolved boundaries must be written back before work is treated as inherited state.

## Integration Boundary

A new project may enter through only these surfaces:

| Surface | Responsibility |
|---|---|
| Body adapter | Capture, playback, rendering, local VAD, device capabilities |
| World adapter | Environment state, external events, scoped world actions |
| Provider adapter | ASR, LLM, TTS, vision, embeddings, or other model services |
| Tool gateway | Permissioned actions with timeout, idempotency, and receipts |

If a proposed project does not fit one of these surfaces, first define the missing boundary instead of letting it absorb adjacent ownership.

## Borrow Before Building

Prefer proven GitHub projects and standards for commodity layers:

- WebSocket/WebRTC and media transport;
- VAD and audio processing;
- authentication and capability tokens;
- JSON Schema and protocol validation;
- tracing, metrics, and replay;
- model-serving adapters;
- existing World and tool runtimes.

Do not reinvent a commodity layer unless the existing option violates a core invariant, cannot run on the target device, or has an unacceptable license or security boundary.

## Attention Filter

Before adopting a large external project, answer:

1. Which existing surface does it replace or strengthen?
2. Which state owner changes?
3. Does it preserve one mind, many bodies, and one active output?
4. What happens when it is offline, slow, compromised, or partially configured?
5. What data leaves the host, and under whose permission?
6. Does it reduce total integration work or only move complexity?
7. Can it be isolated behind an adapter and removed without rewriting the core?

Until those answers are clear, keep the project in an experimental integration path. It must not become the new center of the product by accident.

## Anti-Goals

- Replacing Hub authority with UI or device state.
- Running the complete LLM, TTS, and avatar stack on every small device.
- Copying memory or identity into each host.
- Granting global AI permissions instead of per-host leases.
- Adding a second LLM decision owner without an explicit architecture decision.
- Letting a large framework dictate the protocol before the protocol dictates its adapter.

## Decision Test

A change is aligned only if the result can be stated as:

> The same mind gains a new capability through a bounded adapter, while Hub ownership, host permissions, active-body routing, protocol versioning, and logging continuity remain intact.
