# Absolute Solver North Star

Absolute Solver is Cortico's cross-device runtime. Its one job is to **project Cortico's capabilities onto the operator's own devices** — the pet/chat surface, the voice, and the workspace/tool abilities Cortico already has. Each device runs its own ASR, TTS, and LLM as the local substrate; SSH is how Cortico reaches it.

The product is deliberately small:

- **Cortico/DSH owns the brain** — Persona, memory, repository work, tools, decisions.
- **SSH owns the road and the lock** — encrypted transport, host-key verification, account authorization, and port forwarding.
- **The device owns its local stack** — ASR, TTS, and LLM run on the device itself.
- **The registry (optional) owns the facts** — a list of host/user/key/capability and the most recent receipts. It does not proxy traffic or mint temporary grants.

The target experience is:

```text
Cortico decides to project itself onto a device
→ open an SSH session to that device (key + known_hosts + account)
→ load Cortico's page/voice on the device and call its local ASR / TTS / LLM
→ return exit code + stdout/stderr as the receipt
→ Cortico confirms the device really shows, plays, and responds
```

## Invariants

1. **Cortico owns decisions; projection carries them, not a copy.** Persona, memory, code work, and tool choice stay in Cortico/DSH. Solver does not add a second agent or a second Persona.
2. **Each device owns its local intelligence.** ASR, TTS, and LLM run simultaneously on the device. Do not centralize all inference or speech on one host.
3. **SSH is the only transport and authorization layer.** Use standard SSH key auth, pinned `known_hosts`, OS accounts, and port forwarding. Do not build a custom WebSocket broker, Presence token, one-time grant, or "no-gate" continuous-connection layer.
4. **Permission equals account permission.** What a device may do is decided by that SSH account's OS and sudo policy. Solver does not grant, amplify, or bypass it. High-risk actions keep Cortico's and the OS's existing confirmations.
5. **Receipts must be real.** Success, failure, and timeout all come from a real SSH session's exit code and output. A plan, a mock, or a screenshot is not execution evidence.
6. **Online is not authorized.** A reachable host is a network fact, not permission to do anything.

## Borrow Before Building

Reuse, in this order:

- `ssh` / `scp` / `rsync` / `ssh -L` for transport, auth, and tunneling;
- the device's own service manager (systemd, scheduled task, container) for running ASR/TTS/LLM;
- Cortico/DSH workspaces, World, and plugins for decisions and code work;
- a flat registry file for device facts — not a message broker.

## Anti-Goals

- Rebuilding a custom message router or permission gate on top of SSH.
- A Presence token that claims where Cortico "is".
- A "no-gate" connection model that bypasses the account's real permissions.
- Centralizing every device's ASR/TTS/LLM into one host.
- Reporting planned, simulated, or screenshot-derived success as executed fact.
- Adding a second agent or a second decision owner.

## Decision Test

A change is aligned only if the result can be stated as:

> Cortico **projects its capabilities** onto a device over SSH, using that device's local ASR/TTS/LLM, and gets a real receipt — without adding a second brain, a second transport, or a second permission model.
