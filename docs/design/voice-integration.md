# Voice Integration (Yapper)

**Status:** Proposed
**Date:** 2026-04-05
**Depends on:** Yapper scaffold (#1), Yapper design doc implementation (#5)
**Author:** Claude (with Dimitri)

## Context

Yapper is a local voice service running Whisper (STT) and Kokoro (TTS) on Apple Silicon. It exposes HTTP and WebSocket endpoints for transcription and synthesis. Mitzo is currently text-only. This doc designs the integration that lets users speak to Claude and optionally hear responses read aloud — all processed locally on the LAN.

**Constraint:** Yapper is a sibling service, not a dependency. Voice is opt-in. Mitzo must work identically when Yapper is unavailable.

## Design Principles

1. **Voice is preprocessing/postprocessing** — not a protocol change. Spoken input becomes text before reaching Claude. Text responses become audio after leaving Claude. The v2 protocol, reducer, query loop, and event store are untouched.
2. **Client-direct** — the Mitzo frontend talks to Yapper directly (not proxied through Mitzo server). The server never handles audio. This avoids doubling bandwidth and keeps the server simple.
3. **Graceful degradation** — if Yapper is unreachable, the mic button disappears. No errors, no broken state.

## Input: Speech-to-Text

### Interaction Model: Push-to-Talk

Hold the mic button to record. Release to send. This is simpler and more reliable than voice-activity detection (VAD), especially on mobile where background noise is unpredictable.

```
User holds mic → browser MediaRecorder captures audio (WebM/Opus)
              → on release, two paths:

  [Batch mode]    POST /v1/transcribe with audio file
                  → receive { text, language, duration }
                  → insert text into ChatInput
                  → user reviews and sends (or edits first)

  [Streaming mode] WS /v1/transcribe/stream
                   → send format frame: { "format": "webm/opus" }
                   → stream audio chunks as binary frames
                   → receive partial transcripts in real-time
                   → display in ChatInput as live preview
                   → on release, send "END", receive final transcript
                   → user reviews and sends
```

### Why Streaming

Batch transcription has a noticeable delay (1-3s for short utterances). Streaming shows words appearing as the user speaks — much better mobile UX. The partial → final flow also lets the user see and correct the transcript before sending.

### Recommended: Start with Batch, Add Streaming

Batch is simpler to implement and test. Ship it first, then layer streaming on top. The UI is the same (mic button + transcript preview) — only the transport changes.

## Output: Text-to-Speech

### Interaction Model: Toggle

A speaker icon in the chat header (or per-message) toggles TTS. When enabled, assistant text responses are sent to Yapper `/v1/synthesize` and played back via the Web Audio API.

```
Assistant message completes (message_end event)
  → extract text blocks (skip thinking, tool_use, tool_result)
  → POST /v1/synthesize { text, voice }
  → receive WAV audio
  → play via AudioContext
```

### Scope Rules

| Block type  | Speak? | Reason                         |
| ----------- | ------ | ------------------------------ |
| text        | Yes    | The actual response            |
| thinking    | No     | Internal reasoning, often long |
| tool_use    | No     | Code/JSON, not human-readable  |
| tool_result | No     | Raw output, often verbose      |

### Chunking for Long Responses

For responses longer than ~500 characters, split at sentence boundaries and synthesize/play sequentially. This reduces time-to-first-audio and avoids sending huge payloads.

### Voice Selection

Expose Yapper's `/v1/voices` endpoint in a settings dropdown. Store preference in localStorage. Default: `af_heart`.

## Architecture

### What Changes

```
┌─────────────────────────────────────────────┐
│  Frontend                                    │
│                                              │
│  ChatInput ──→ useVoice() ──→ Yapper WS/HTTP │
│     │              │                          │
│     │         transcribed text                │
│     ▼              │                          │
│  ChatView ◄────────┘                          │
│     │                                         │
│     │  (on message_end, if TTS enabled)       │
│     ▼                                         │
│  useVoice().speak(text) ──→ Yapper HTTP       │
│     │                                         │
│     ▼                                         │
│  AudioContext.play()                          │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  Mitzo Server                                │
│                                              │
│  (unchanged — receives text, sends text)     │
└─────────────────────────────────────────────┘
```

### New Files

| File                                        | Purpose                                                         |
| ------------------------------------------- | --------------------------------------------------------------- |
| `frontend/src/hooks/useVoice.ts`            | Recording, transcription, TTS playback, Yapper connection state |
| `frontend/src/lib/audio.ts`                 | MediaRecorder wrapper, AudioContext playback, format helpers    |
| `frontend/src/components/MicButton.tsx`     | Push-to-talk button with visual recording indicator             |
| `frontend/src/components/VoiceSettings.tsx` | Voice selection, TTS toggle (in settings/header)                |

### Modified Files

| File                                    | Change                                                         |
| --------------------------------------- | -------------------------------------------------------------- |
| `frontend/src/components/ChatInput.tsx` | Add MicButton next to send, wire `onTranscript` to insert text |
| `frontend/src/pages/ChatView.tsx`       | Pass `useVoice` state, trigger TTS on message_end              |
| `frontend/src/lib/constants.ts`         | Add `YAPPER_URL` default, `MAX_RECORDING_DURATION_MS`          |

### Files NOT Modified

- `server/*` — server never sees audio
- `frontend/src/hooks/useChatMessages.ts` — reducer unchanged
- `frontend/src/hooks/useChatConnection.ts` — WS pool unchanged
- `server/query-loop.ts` — v2 protocol unchanged

## Configuration

```env
# .env (frontend build-time or runtime)
VITE_YAPPER_URL=http://yapper.local:8700   # or http://localhost:8700
```

The frontend fetches `/health` on mount. If reachable, voice features appear. If not, they stay hidden. Re-checked periodically (every 30s) so voice appears when Yapper comes online.

## useVoice Hook API

```typescript
interface UseVoiceReturn {
  // State
  available: boolean; // Yapper reachable
  recording: boolean; // Currently recording
  transcript: string; // Current (partial or final) transcript
  speaking: boolean; // TTS audio playing
  ttsEnabled: boolean; // TTS toggle state

  // Actions
  startRecording: () => void; // Begin capture
  stopRecording: () => Promise<string>; // End capture, return final text
  cancelRecording: () => void; // Discard without transcribing
  speak: (text: string) => Promise<void>; // Synthesize and play
  stopSpeaking: () => void; // Interrupt playback
  setTtsEnabled: (v: boolean) => void;
  setVoice: (id: string) => void;

  // Voice list (fetched from Yapper)
  voices: Array<{ id: string; name: string; language: string; gender: string }>;
}
```

## MicButton UX

### States

| State        | Visual         | Behavior                              |
| ------------ | -------------- | ------------------------------------- |
| Idle         | 🎙 grey        | Tap-and-hold to start recording       |
| Recording    | 🎙 red + pulse | Release to stop, swipe away to cancel |
| Transcribing | ⏳ spinner     | Waiting for Yapper (batch mode only)  |
| Unavailable  | (hidden)       | Yapper not reachable                  |

### Mobile Considerations

- `useLongPress` hook already exists — reuse for hold-to-record
- Haptic feedback on record start/stop (`navigator.vibrate`)
- Recording indicator must be visible even with keyboard open
- Cancel gesture: drag finger away from button (using touch events)

## Open Questions

1. **Streaming vs batch for MVP?** Recommendation: batch first. Simpler, testable, covers the core use case. Streaming is a follow-up.
2. **Auto-send after transcription?** Recommendation: no. Let the user review and edit. Voice recognition isn't perfect. A "send immediately" toggle could come later.
3. **TTS interruption on new user message?** Recommendation: yes. If the user sends a new message while TTS is playing, stop playback immediately.
4. **Multi-language?** Yapper supports language config but defaults to English. Punt on language detection/switching for MVP.
5. **Yapper model readiness?** The `/health` endpoint doesn't report model load status. Consider adding `/health` → `{ status: "ok", models: { stt: "ready", tts: "ready" } }` to Yapper so Mitzo can show "loading models..." instead of just hiding the mic.

## Implementation Plan

### Phase 1: Batch STT (MVP)

1. `audio.ts` — MediaRecorder capture, blob-to-FormData
2. `useVoice.ts` — recording state, POST to `/v1/transcribe`, health polling
3. `MicButton.tsx` — hold-to-record with long-press
4. Wire into `ChatInput.tsx` — insert transcript into textarea
5. Tests for hook + component

### Phase 2: TTS Playback

1. `useVoice.ts` — `speak()` via POST `/v1/synthesize`, AudioContext playback
2. `VoiceSettings.tsx` — voice picker, TTS toggle
3. Wire into `ChatView.tsx` — trigger on `message_end`
4. Chunked synthesis for long responses
5. Tests

### Phase 3: Streaming STT

1. `audio.ts` — WebSocket streaming, format negotiation
2. `useVoice.ts` — partial transcript state, WS lifecycle
3. Live preview in ChatInput during recording
4. Tests

Each phase is a separate PR. Each PR includes tests (TDD per Mitzo convention).
