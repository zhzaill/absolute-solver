# Changelog

## Unreleased

- Added optional `segment.receipt` (body → hub): a body reports `played`/`skipped`/`dropped` per segment with a bounded `reason`, optional `pcm_ms`, and an optional `count` so a discarded burst stays one message. Audio never travels in a receipt, and playback never depends on one being delivered.
- The Hub now keeps the body's view (`segments_played_body`, `segments_skipped_body`, `segments_dropped_body`, per-device counters, `last_segment_receipt`) separate from its own estimate (`segments_sent`, `segments_dropped`), plus a per-turn `segment_receipt_status` (`none`/`missing`/`partial`/`complete`) so "no receipts yet" is distinguishable from "this body never reports". Duplicates are idempotent, turns outside a four-turn window count as stale, and a receipt for a turn that never produced segments counts as unmatched.
- Fixed a truncated reply: a one-shot body (WAV replay or microphone capture) left after the first segment finished, so later segments and their receipts were never produced. `say.last` now propagates to the playback event and the body exits only after the turn's final segment plays.
- Added segmented TTS (first-segment-first): the Hub splits the reply on sentence boundaries, synthesizes segments with bounded concurrency (2), and streams `say` frames in `seq` order with optional `seg_total`/`last` fields; a failed first segment degrades the whole reply, a failed later segment degrades to a subtitle cue.
- Added `segments` module: pure splitter with soft/hard character budgets that never cuts inside ASCII words, numbers, URLs, or inline code.
- The audio body now queues segments (ordered by `next_seq`, bounded to 32, dropping duplicates, stale turns, and out-of-order arrivals) and plays them through one continuous cpal stream instead of one PowerShell process per segment, removing the inter-segment gap.
- Fixed a playback defect found by ear: a mono buffer was written one sample per interleaved slot, so a stereo device played it at double speed. Frames are now filled per channel, with regression tests.
- Completed the native TTS output loop: a Rust audio body advertises `speaker` plus `media: ["pcm16-binary"]`, receives `say` metadata with the matching `say.audio` frame, plays it on the local speaker, and records `playback` trace entries.
- Added lenient protocol parsing: an unknown `type` now yields `protocol.error{code:"unknown_type",fatal:false}` and keeps the connection open; bodies log `unknown.type` and continue instead of dropping the socket.
- Added `say` delivery accounting (`say_sent`, `say_undelivered`, `last_say`) and the `tts.no_playback_receiver` trace event for "synthesized but no audio body".
- Fixed Hub restart recovery: a torn JSONL line no longer blocks startup (`load_trace_lossy` reports skipped records as `trace.recovered`), and `TraceWriter` terminates a torn tail before appending so the next record is not glued to it.
- Defaulted `SOLVER_TTS_PROMPT_LANG` to `zh` to match the configured voice.
- Added `tools/protocol-unknown-type-smoke.mjs` and release acceptance evidence under `D:\11\Logs\`.
- Segmentation hardening: an `interrupt` `render.cue` makes the body skip queued chunks of a superseded turn (the chunk already handed to the device still finishes), the queue is bounded by 32 segments / 8 MiB, and a segmented turn stops at `SOLVER_TTS_TURN_BUDGET_SECONDS`, degrading the remainder to subtitles.

## 0.3.0

- Added scoped, short-lived Host presence intents with explicit local policy decisions.
- Added `presence.intent`, `presence.decision`, `presence.grant`, and `presence.revoke` protocol messages.
- Added `POST /presence/intent` and `POST /presence/revoke` service-authenticated operator APIs.
- Added a Tauri tray host with notify/appear/reject policy, full-screen overlay, TTL countdown, and immediate revoke.
- Added a bounded read-only Robotics World projection for camera, YOLO, mapping, navigation, and robot health.
- Kept WebSocket v1 plus binary PCM16; gRPC was evaluated and not adopted. Unused gRPC build dependencies were removed.
- Added an HTTP + WebSocket presence smoke test.

## 0.2.1

- Added optional PCM16 binary media frames over WebSocket.
- Added targeted `turn.started` acknowledgements for body-created speech turns.
- Added structured `protocol.error` frames for malformed media and protocol input.
- Added Host Panel microphone capture with local VAD, pre-roll, and half-duplex playback gating.
- Added binary media and structured-error smoke coverage.

## 0.2.0

- Introduced the public Absolute Solver protocol v1 envelope.
- Added generated v1 wire and state JSON Schemas.
- Added legacy unversioned client compatibility as v1.
- Added active-body routing and `body.handoff`.
- Added Host Panel and one-time Cortico host connection tickets.
- Added ASR → LLM → TTS pipeline, subtitle degradation, SQLite memory, and monitor endpoints.
- Added deterministic smoke tests for active-body routing and Host Panel registration.
