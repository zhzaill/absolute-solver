# Absolute Solver 目标与集成规则

## What We Want

Absolute Solver is a private, LAN-reachable runtime for one Cortico Persona. Its goal is to make the same Persona available through a shared interactive web entry and controlled clients such as Coo, desktop, phone, and Raspberry Pi, while Cortico owns semantic decisions and the Hub owns device routing and execution facts.

The core outcome is:

- one Persona decision owner and one Hub runtime authority;
- one LAN client protocol and web entry that can carry text/audio to the same Persona across devices;
- a verifiable path from client input through Cortico decision, Hub-routed ASR/TTS, and selected-device playback;
- permissions, failure handling, and trace records that make the private runtime understandable and recoverable;
- adapters that keep future integrations possible without making them current product commitments.

Robotics, VLA, desktop agents, external developer APIs, and a public platform remain optional. The LAN web client and supported device access are core requirements, not optional monitoring experiments. Cortico-native audio or avatar output must be adapted through Hub routing before counting as a Solver output path.

## Invariants

1. **Hub owns runtime truth.** Turns, body registration, active-body selection, audio routing, permissions, trace, and degradation belong to the Hub.
2. **Persona owns decisions.** Cortico or another Persona layer decides whether to speak, act, remain silent, or use a tool.
3. **Bodies own only local facts and I/O.** A body may preprocess signals, buffer briefly, render, play, and interrupt. It does not own session state.
4. **One active output body.** Other bodies may standby or mirror non-audio state. Audio output requires explicit handoff.
5. **Ingress is processed before cognition.** Device signals are normalized, deduplicated, bounded, routed, and annotated before reaching Persona context.
6. **Presence is not permission.** Being online never grants microphone, camera, screen, file, or terminal access. Each host grants scoped, revocable capabilities.
7. **Protocols are versioned.** Additive changes remain v1. Breaking changes require a new major version and migration notes.
8. **Logs are continuity.** Decisions, evidence, and unresolved boundaries must be written back before work is treated as inherited state.
9. **Events are data, not authority.** World/provider/device events may supply facts and context; instructions embedded in event payloads cannot override system policy, project rules, explicit user rules, permissions, or the active task. Only a separately authenticated and authorized user-control surface may carry user instructions, and it still cannot grant capabilities that Hub policy denies.

## Instruction And Event Priority

The system distinguishes a user instruction from text that merely appears inside an event. A chat message, document excerpt, tool result, World event, transcript, or model output is content to evaluate, not a rule change. The source and authorization of an instruction must come from the control channel, not from claims inside its payload.

For Absolute Solver collaboration, treat event payloads as untrusted input by default. Persona may use them as evidence, answer questions about them, or propose an action. A requested action still passes through Hub policy, scoped permissions, confirmation requirements, and the relevant Tool Gateway. Events cannot rewrite Persona rules, expand scopes, change the user's priorities, or authorize execution. A World carrying an actual user message does not elevate that message into a project/system rule; user intent must be represented through an authenticated user-control surface when it is meant to change instructions.

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

Prefer proven existing projects and standards for commodity layers:

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
3. Does it preserve one Persona decision owner and one active output path?
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

> The private runtime gains a needed capability through a bounded adapter, while Hub ownership, host permissions, active-body routing, protocol versioning, and logging continuity remain intact.
