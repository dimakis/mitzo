# Streaming STT (Phase 3)

**Status:** Proposed
**Date:** 2026-04-05
**Depends on:** Phase 1 — Batch STT (#105), Phase 2 — TTS Playback (#108)
**Author:** Claude (with Dimitri)

## Context

Phases 1 and 2 delivered batch STT and TTS playback. Batch transcription works but has a noticeable delay (1-3s after release before text appears). Phase 3 replaces batch with streaming transcription — words appear in the input box as the user speaks, with a final transcript on release.

**Constraint:** Streaming is a transport upgrade, not a protocol change. The v2 protocol, reducer, and server are untouched. The UI contract is the same: mic button → transcript → textarea.

## Yapper Streaming Protocol

### `WS /v1/transcribe/stream`

```
1. Client opens WebSocket to /v1/transcribe/stream
2. Client sends text frame: {"format": "webm/opus"}
3. Client sends binary frames (audio chunks) during recording
4. Client sends text frame: "END" on recording stop
5. Server sends JSON frames:
   - {"type": "partial", "text": "I wanted to"}       (every ~2s)
   - {"type": "partial", "text": "I wanted to check"}  (revised)
   - {"type": "final", "text": "I wanted to check the status."}
```

### Key behaviors

- **Partials overwrite, not append** — Whisper re-transcribes the entire accumulated buffer. Each partial replaces the previous one entirely.
- **Format negotiation** — first text frame declares format. `webm/opus` triggers server-side ffmpeg decode. Omitting defaults to PCM.
- **`END` must be a text frame** — binary frame with "END" content is treated as audio.
- **No per-frame acknowledgment** — server accepts audio silently. Only error signal is WebSocket disconnect.
- **No heartbeat** — not a problem for speech (continuous audio frames), but worth noting.

## Architecture

### What Changes

```
Phase 1 (batch):
  MediaRecorder → stop → Blob → POST /v1/transcribe → transcript

Phase 3 (streaming):
  MediaRecorder → timeslice chunks → WS /v1/transcribe/stream → live partials
                → stop → "END" → final transcript
```

### Changes to `lib/audio.ts`

Add `createStreamingRecorder()` that uses `MediaRecorder.start(timeslice)` to emit chunks during recording instead of one blob at the end:

```typescript
export interface StreamingRecorder {
  start: () => void;
  stop: () => void;
  cancel: () => void;
  onChunk: ((data: Blob) => void) | null;
  onStop: (() => void) | null;
}

export function createStreamingRecorder(
  stream: MediaStream,
  mimeType: string,
  timesliceMs?: number,
): StreamingRecorder;
```

`timesliceMs` defaults to 250ms — frequent enough for low latency, infrequent enough to avoid overhead.

### New: `lib/yapper-ws.ts`

WebSocket client for Yapper's streaming transcription:

```typescript
export interface YapperStreamClient {
  /** Send format declaration. Call once before sending audio. */
  sendFormat: (format: string) => void;
  /** Send an audio chunk (binary). */
  sendAudio: (data: ArrayBuffer) => void;
  /** Signal end of audio. Server will send final transcript. */
  sendEnd: () => void;
  /** Close the WebSocket. */
  close: () => void;
  /** Register callback for partial/final transcripts. */
  onTranscript: ((event: { type: 'partial' | 'final'; text: string }) => void) | null;
  /** Register callback for errors. */
  onError: ((error: Event) => void) | null;
}

export function createYapperStreamClient(url: string): YapperStreamClient;
```

Separated from the hook for testability. The WebSocket lifecycle is short-lived (one per recording session), not long-lived like the Mitzo chat connection.

### Changes to `hooks/useVoice.ts`

Add streaming mode alongside existing batch mode. The hook detects Yapper availability and uses streaming when the WebSocket endpoint is reachable:

```typescript
// New fields in UseVoiceReturn
interface UseVoiceReturn {
  // ... existing fields ...
  partialTranscript: string; // Live preview during streaming recording
  streamingSupported: boolean; // WS endpoint available
}
```

The `startRecording()` flow becomes:

```
1. getUserMedia → stream
2. Open WS to /v1/transcribe/stream
3. Send format frame
4. createStreamingRecorder(stream, mimeType, 250)
5. onChunk → send binary to WS
6. WS onTranscript → update partialTranscript state
7. On stop: send "END", wait for final, return final text
8. On cancel: close WS, discard
```

Batch mode remains as fallback if WebSocket connection fails.

### Changes to `components/ChatInput.tsx`

Show `partialTranscript` as live preview in the textarea during recording:

- While `recording && partialTranscript`: show partial text in textarea (greyed/italic)
- On final transcript: replace with final text (normal style)
- User can still edit before sending

### Changes to `components/MicButton.tsx`

No changes needed — the button states (idle, recording, transcribing) are the same. The only difference is that "transcribing" state is much shorter (just the final transcript delay, not the full audio processing).

## File Changes

### New Files

| File                                           | Purpose                                      |
| ---------------------------------------------- | -------------------------------------------- |
| `frontend/src/lib/yapper-ws.ts`                | WebSocket client for streaming transcription |
| `frontend/src/lib/__tests__/yapper-ws.test.ts` | Tests for WS client                          |

### Modified Files

| File                                            | Change                                              |
| ----------------------------------------------- | --------------------------------------------------- |
| `frontend/src/lib/audio.ts`                     | Add `createStreamingRecorder()` with timeslice      |
| `frontend/src/lib/__tests__/audio.test.ts`      | Tests for streaming recorder                        |
| `frontend/src/hooks/useVoice.ts`                | Streaming recording flow, `partialTranscript` state |
| `frontend/src/hooks/__tests__/useVoice.test.ts` | Streaming STT tests                                 |
| `frontend/src/components/ChatInput.tsx`         | Live transcript preview during recording            |

### Files NOT Modified

- `server/*` — server never sees audio
- `frontend/src/hooks/useChatMessages.ts` — reducer unchanged
- `frontend/src/lib/tts.ts` — TTS module unchanged
- `frontend/src/components/MicButton.tsx` — button states unchanged
- `frontend/src/components/VoiceSettings.tsx` — TTS settings unchanged

## Live Preview UX

During streaming recording, the textarea shows the partial transcript in real-time:

```
State: Recording + partial available
┌──────────────────────────────┐
│ I wanted to check the...     │  ← greyed text, updating live
└──────────────────────────────┘

State: Final transcript received
┌──────────────────────────────┐
│ I wanted to check the status.│  ← normal text, editable
└──────────────────────────────┘
```

The partial text is displayed but not set as the textarea `value` (to avoid cursor jumps). Instead, it's shown as a visual overlay or placeholder-like element that disappears when the final text lands.

Implementation: a `<div>` overlay inside the input area that shows `partialTranscript` when recording, hidden otherwise. The final transcript is inserted into the actual textarea value.

## Error Handling

| Scenario                                  | Behavior                                                  |
| ----------------------------------------- | --------------------------------------------------------- |
| WS connection fails                       | Fall back to batch mode silently                          |
| WS disconnects mid-recording              | Use accumulated partials as best-effort transcript        |
| No partials received                      | Normal — short recordings may finish before first partial |
| Format negotiation ignored (PCM fallback) | Works fine if Yapper has ffmpeg                           |

## Implementation Plan (TDD)

### Step 1: `lib/audio.ts` — streaming recorder (test-first)

- `createStreamingRecorder()` with `timeslice` param
- `onChunk` callback fires with each Blob chunk
- `onStop` callback fires when recording ends
- Auto-stop timer (reuse `MAX_RECORDING_DURATION_MS`)
- Tests: chunk emission, stop, cancel, auto-stop

### Step 2: `lib/yapper-ws.ts` — WebSocket client (test-first)

- `createYapperStreamClient()` wrapping native WebSocket
- `sendFormat()`, `sendAudio()`, `sendEnd()`, `close()`
- `onTranscript` callback for partial/final events
- `onError` callback
- Tests with mock WebSocket: format frame, audio send, transcript events, error handling

### Step 3: Extend `useVoice.ts` with streaming (test-first)

- `partialTranscript` state, updated on each WS partial event
- `streamingSupported` derived from WS connection test (or just always attempt, fallback on failure)
- Modified `startRecording()` / `stopRecording()` to use streaming when available
- Batch fallback on WS failure
- Tests: streaming flow, fallback to batch, partial updates, cancel mid-stream

### Step 4: Wire live preview into ChatInput

- Overlay `<div>` showing `partialTranscript` during recording
- Replace with final text on stop
- CSS for live preview styling (greyed, italic)
- Tests: preview visibility, final text insertion

### Step 5: Full verification

- Full test suite pass
- Lint clean
- Manual testing checklist

Each step is test-first, committed atomically. Single PR at the end.

## Open Questions

1. **Timeslice value?** 250ms is a good balance. Too low (50ms) creates overhead; too high (1000ms) adds latency to partials. Can be tuned later.
2. **Should streaming be the default or opt-in?** Recommendation: default when available, with batch as silent fallback. No user-facing toggle needed.
3. **Partial display: overlay vs placeholder?** Overlay is cleaner — doesn't interfere with textarea state. Placeholder approach would require managing cursor position.
