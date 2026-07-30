# Codex Realtime Integration

Verified against Codex CLI/app-server 0.145.0 on 2026-07-22. This document records observed behavior, not inferred product naming.

## Protocols and transports

`thread/realtime/start` supports two transports:

- WebSocket: omit `transport` or pass `{ "type": "websocket" }`.
- WebRTC: pass `{ "type": "webrtc", "sdp": "..." }`.

The `version` field selects the event protocol, not the network transport:

- V1: legacy Bidi (`conversation.handoff.*`).
- V2: Realtime Voice API.
- V3: Frameless Bidi (`delegation.*`).

Codex maps V1/V2 WebSocket traffic to `/v1/realtime`. V1 WebRTC call creation uses `/v1/realtime/calls?intent=quicksilver&architecture=avas`. V3 uses `/v1/live` for both WebSocket and WebRTC call creation. V2 WebRTC is rejected locally by app-server; V2 is usable through its server-side WebSocket transport.

## Models

The public model catalog for the configured VoiceClaw API project included:

- `gpt-realtime-2.1`
- `gpt-realtime-2.1-mini`
- `gpt-realtime-2`
- older Realtime and audio models

Codex 0.145.0 defaults V3 to `gpt-live-1-boulder-alpha`. That identifier was not present in the public `/v1/models` response and should be treated as an app-server implementation detail, not a public model-picker value. No supported documentation or model-catalog result established `gpt-live-1` or `gpt-live-1-mini` as public model IDs.

Direct model lookups for `gpt-live-1`, `gpt-live-1-mini`, and `gpt-live-1-boulder-alpha` returned `model_not_found` for the configured API project. That result means the project cannot currently select those IDs; it does not prove that the internal V3 default is fictitious.

## Observed authentication and admission

- Public API-key WebSocket to `gpt-realtime-2.1-mini`: session opened and returned the requested response.
- Public API-key WebSocket to `gpt-realtime-2.1`: session opened.
- Public API-key WebRTC to `gpt-realtime-2.1-mini`: HTTP 201, remote SDP accepted, peer connected, data channel opened, and the requested response returned.
- Codex app-server V2 WebSocket plus API key and `gpt-realtime-2.1-mini`: session opened, streamed user transcript deltas, emitted output-audio chunks, and started the associated Codex turn/handoff.
- Codex app-server V1 WebSocket can report startup, but audio then fails because the backend requires Quicksilver sessions to use WebRTC. V1 WebRTC reached its AVAS call endpoint and was denied voice-session admission.
- Codex app-server V3 WebSocket plus API key: backend rejected with `Voice session access denied`.
- Codex app-server V3 WebRTC plus API-key Codex login: `/v1/live` returned HTTP 403 `Voice session access denied`.
- Codex app-server V3 WebRTC plus ChatGPT Codex login: the ChatGPT Codex call route returned HTTP 404.
- Codex app-server V3 WebSocket plus ChatGPT Codex login: app-server rejected startup because its current implementation requires API-key auth for realtime WebSocket.

The local `realtime_conversation` feature flag being enabled establishes that the client surface exists. It does not establish backend admission.

### Results matrix

| Surface | Protocol | Transport | Model | Result |
| --- | --- | --- | --- | --- |
| Public Realtime API | GA Realtime | WebSocket | `gpt-realtime-2.1-mini` | Verified session and exact requested text response |
| Public Realtime API | GA Realtime | WebSocket | `gpt-realtime-2.1` | Verified session startup |
| Public Realtime API | GA Realtime | WebRTC | `gpt-realtime-2.1-mini` | Verified HTTP 201, SDP, data channel, peer connection, and response |
| Codex app-server | V2 Realtime Voice | WebSocket | `gpt-realtime-2.1-mini` | Verified audio input, user/assistant transcripts, Codex handoff events, and 24 kHz output audio |
| Codex app-server | V2 Realtime Voice | WebSocket | `gpt-realtime-2.1` | Verified audio input, transcripts, and 24 kHz output audio |
| Codex app-server | V1 Legacy Bidi | WebSocket | app-server default | Startup can acknowledge; audio rejects because Quicksilver requires WebRTC |
| Codex app-server | V1 Legacy Bidi | WebRTC | `gpt-realtime-2.1-mini` | Reached AVAS call endpoint; backend denied voice-session admission |
| Codex app-server | V3 Frameless Bidi | WebSocket | V3 default / public model override | Backend denied voice-session admission |
| Codex app-server | V3 Frameless Bidi | WebRTC | V3 default / public model override | Reached `/v1/live`; backend denied voice-session admission |
| Public model lookup | N/A | HTTPS | `gpt-live-1`, `gpt-live-1-mini`, `gpt-live-1-boulder-alpha` | `model_not_found` for the configured project |

Official public references: [Realtime overview](https://developers.openai.com/api/docs/guides/realtime), [WebRTC transport](https://developers.openai.com/api/docs/guides/realtime-webrtc), [GPT-Realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1), and [GPT-Realtime-2.1 mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini).

## VoiceClaw integration boundary

1. Keep public GPT Realtime 2.1/2.1-mini as the production API-key WebRTC path on iOS.
2. Keep Codex V3 as a separate capability-gated GPT Live experiment. Do not silently fall back from V3 to V2 while labeling the result GPT Live.
3. Use the Companion's durable Codex text-turn bridge for supported ChatGPT-authenticated Codex reasoning now.
4. If a Codex-mediated voice fallback is desired before V3 admission is granted, explicitly label it as Codex + GPT Realtime 2.1 and relay app-server V2 WebSocket media through the Companion. It is not Frameless Bidi V3.
5. Preserve SDP bytes exactly. Removing the terminal CRLF caused the Realtime call parser to reject valid browser offers with `invalid_offer` / `EOF`.

### Verified Companion relay

The Companion exposes the verified V2 path at `/realtime/codex/ws`. This is a bridge-authenticated WebSocket endpoint and requires authentication in the HTTP upgrade request before it allocates a Codex app-server process or thread.

- The first server event is `ready` and identifies protocol `v2`.
- Start with a JSON `start` control. The default model is `gpt-realtime-2.1-mini`, the default voice is `marin`, and input is signed 16-bit little-endian PCM. A caller may select a supported sample rate and one or two channels.
- After `started`, send PCM as binary WebSocket messages or use a base64 `input_audio` control. `input_text`, `input_speech`, `ping`, and `stop` are also supported.
- Output audio is sent as an `output_audio` JSON metadata event immediately followed by its binary PCM frame. Other app-server notifications are wrapped as `codex_realtime_event` without changing their payload.
- The relay rejects V1/V3 instead of silently downgrading. V3 remains a separate `/v1/live` admission question.

This endpoint is intentionally named and reported as Codex Realtime Voice V2, not GPT Live. It currently needs an OpenAI API key available to the Codex app-server process.

## Diagnostics contract

Companion diagnostics retain admission evidence by both transport and protocol version. A verified V2 path must not be reported as V3 admission, and a later failed V3 probe must not erase a previously verified V1/V2 path.

## Companion-owned Computer Use transport

VoiceClaw computer-capable Codex tasks use an isolated helper transport. The
Companion discovers the signed Computer Use helper beside the selected Codex
installation, validates its OpenAI signature, and launches only that helper as
its own supervised child with `SKY_CUA_SERVICE_NATIVE_PIPE_PATH` pointing to a
process-private socket. The Codex app-server and its configured `node_repl`
inherit the matching `SKY_CUA_NATIVE_PIPE_PATH`.

Readiness has two distinct stages:

1. `socket_ready` means the Companion-owned helper is running and its private
   socket exists. This is warm-up only and does not admit a user turn.
2. `ready` means the Companion invoked the plugin-owned Computer Use wrapper
   through Codex app-server's documented `mcpServer/tool/call` method inside
   the exact Codex thread that will receive the task. A read-only `list_apps`
   call must complete through the native pipe before the user turn is sent.

The thread-scoped probe is required because the helper rejects standalone
clients that lack Codex turn authentication metadata. A retryable failure may
restart the Companion-owned helper and repeat this pre-dispatch probe once.
The user turn has not started at that point. After `turn/start`, VoiceClaw does
not replay the turn or repeat successful UI actions; a failure is surfaced as
the task result.

Ordinary Codex work does not acquire this transport. iOS sets the explicit
`computer_use` request flag only for visible Mac UI work such as opening or
operating an app, clicking, typing, scrolling, or switching windows. Coding,
shell work, repository work, research, and normal file operations remain on
the ordinary Codex route.

Acceptance on 2026-07-30 used Codex app-server `0.146.0-alpha.3.1`: twenty
consecutive read-only TextEdit state requests succeeded through the private
socket, terminating the Companion-owned helper recovered on the same Codex
thread with a new helper PID, and the existing ChatGPT-owned default helper
remained running and untouched.
