# Streaming speech input

**Status:** Implemented; reliability and latency improvements in PR #688 and Yapper PR #13
**Updated:** 2026-10-01

This replaces the April 2026 Phase 3 proposal. Streaming audio and live transcript previews already existed. The remaining delay came from inference scheduling, unused word timestamp work, the growing Whisper buffer, and incorrect recording finalization.

## Current path

1. Tap the microphone to begin recording. MediaRecorder emits audio chunks every 250 ms, negotiating WebM/Opus, WebM, or MP4 on Safari/iOS.
2. Mitzo proxies the audio WebSocket through `/api/yapper-ws/v1/transcribe/stream`. The client declares the container format before sending audio.
3. Yapper decodes compressed audio into mono 16 kHz PCM. Whisper transcribes the accumulated audio after each second of received samples, returning a replacement partial transcript. This is periodic inference, not a native streaming model or a word-by-word guarantee.
4. Mitzo displays partial text as a preview. A partial is never submitted as a completed voice message.
5. On stop, the client waits for the recorder's final chunk and ordered Blob conversions before sending the text frame `END`. The final response listener is registered before sending `END`; its five-second timeout starts after `END`.
6. Yapper reuses the latest transcript only when it already covers every received sample. Any remaining audio receives a final decode.
7. If streaming is rejected, disconnects, or times out, Mitzo uses its complete batch recording rather than submitting an incomplete partial. Cancellation invalidates the capture, settles pending work, aborts batch requests, and releases recording resources.

Both streaming and HTTP batch inference run in worker threads and share the engine's inference lock. The lock must never be awaited synchronously on the server event loop. Streaming omits word timestamps because the current protocol exposes only text.

The agent receives an ordinary text prompt. Audio does not change the agent message protocol, permissions, or event history.

## Observed latency

An approved local test used `mlx-community/whisper-large-v3-turbo` and the public Whisper JFK fixture, paced as 250 ms PCM frames. On this Mac, for that 11-second recording:

- First partial: 3.273 seconds on the original engine, 1.415 seconds after the improvements.
- Final response after capture: 0.826 seconds originally, 0.479 seconds after the improvements.
- Longest event-loop heartbeat gap: 1.275 seconds originally, 0.025 seconds after the improvements.
- The final transcript matched between versions.

The actual FastAPI PCM WebSocket route was also tested with a 10.75-second recording to exercise a final audio tail. It produced a partial at 1.411 seconds and a final transcript 0.455 seconds after capture ended.

These are measurements on one public recording, not browser/iPhone latency or general speech-accuracy guarantees. MediaRecorder buffering, codec decoding, network delay, speech content, and host load can change the result.

## Acceptance for this increment

- Final recorder data and asynchronous conversions precede `END`, preserving audio order.
- A slow conversion does not consume the final-response timeout.
- Cancellation settles a pending stop even if a conversion never finishes.
- Stale callbacks and late batch results cannot affect a newer capture.
- Streaming errors recover the complete recording.
- MP4 is decoded from a pipe in an automated test, beyond merely accepting its format name.
- Batch and streaming inference leave the event loop responsive.
- A final tail is decoded; an unchanged buffer is not decoded twice.
- Mocked regression tests, lint/type checks, applicable native/browser CI, and approved local speech validation pass.

## Revised rollout

### 1. Reliable, responsive dictation

The changes above are the first increment. Merge and deploy through the usual release workflow, then verify microphone input and live previews on the deployed browser and iOS application. Preserve explicit read-aloud controls.

### 2. Long utterances

Whisper still re-transcribes a growing buffer. Benchmark longer utterances and noisy conversational speech before selecting a bounded-window strategy. Evaluate overlapping windows with a stable committed prefix; verify that revisions, repeated phrases, silence, and boundary words do not lose or duplicate text. Every step remains test-first, and real model tests require the user's model-policy approval.

### 3. Streaming speech playback

Expose incremental Kokoro audio and consume it without waiting for a complete WAV. Begin synthesis on stable response phrases rather than a completed agent message. Keep queues bounded and stop obsolete playback immediately. This belongs to an explicit voice session; ordinary text chats retain manual read-aloud and do not resume automatic narration.

### 4. Conversation lifecycle and additional endpoints

Add turn detection and speech interruption after both speech directions are reliable. Interrupting speech should stop playback and pending speech generation; it must not automatically cancel an unrelated coding task or tool operation. Reuse existing Mitzo sessions and permissions. Validate native iOS audio capture/routing, then CarPlay and room endpoints as separate increments with their own acceptance tests.

This document is an engineering plan. No active Telos parent for the broader voice feature was found during the October 1 audit; older completed Yapper entries are not evidence that this rollout is complete.
