# Changelog

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
