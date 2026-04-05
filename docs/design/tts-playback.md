# TTS Playback (Phase 2)

**Status:** Proposed
**Date:** 2026-04-05
**Depends on:** Phase 1 — Batch STT (#105)
**Author:** Claude (with Dimitri)

## Context

Phase 1 added speech-to-text: hold the mic, speak, transcript lands in the input box. Phase 2 closes the loop — Claude speaks back. When TTS is enabled, completed assistant text responses are sent to Yapper's `/v1/synthesize` endpoint and played via the Web Audio API. Everything stays local, client-direct, and opt-in.

## Design Principles

Carried forward from the voice integration design doc:

1. **Voice is postprocessing** — TTS happens after the message is finalized. The v2 protocol, reducer, and query loop are untouched.
2. **Client-direct** — the frontend talks to Yapper directly. No audio flows through the Mitzo server.
3. **Graceful degradation** — if Yapper is offline or TTS models aren't loaded, the speaker toggle is hidden. No errors, no broken state.

## Yapper TTS API

Already implemented in Yapper (no changes needed):

### `POST /v1/synthesize`

```typescript
// Request
{ text: string; voice?: string; speed?: float }

// Response: raw WAV audio (Content-Type: audio/wav)
```

### `GET /v1/voices`

```typescript
// Response
{
  voices: Array<{
    id: string; // e.g. "af_heart"
    name: string; // e.g. "Heart"
    language: string; // e.g. "American English"
    gender: string; // e.g. "female"
  }>;
}
```

### `GET /health`

Already polled by Phase 1. Response includes `models.tts: boolean` — we use this to gate TTS availability separately from STT.

## Interaction Model

### TTS Toggle

A speaker icon in the chat header toggles TTS on/off. State persists in localStorage. When enabled:

1. Assistant message completes (`MESSAGE_END` action in reducer)
2. Extract text blocks from the finished message (skip `thinking`, `tool_use`, `tool_result`)
3. If text is short enough (< 500 chars), synthesize in one request
4. If text is long, chunk at sentence boundaries and synthesize/play sequentially
5. Play audio via `AudioContext`

### Interruption Rules

| Event                         | Behavior                          |
| ----------------------------- | --------------------------------- |
| User sends new message        | Stop playback immediately         |
| User taps speaker toggle off  | Stop playback immediately         |
| New assistant message starts  | Stop previous playback, queue new |
| User navigates away from chat | Stop playback                     |

### What Gets Spoken

| Block type          | Speak? | Reason                              |
| ------------------- | ------ | ----------------------------------- |
| `text`              | Yes    | The actual response                 |
| `thinking`          | No     | Internal reasoning, often very long |
| `redacted_thinking` | No     | Not visible to user either          |
| `tool_use`          | No     | JSON/code, not human-readable       |
| Tool result content | No     | Raw output, often verbose           |

## Architecture

### Changes to `useVoice.ts`

Extend the existing hook with TTS state and methods:

```typescript
// New fields added to UseVoiceReturn
interface UseVoiceReturn {
  // ... existing STT fields ...

  // TTS state
  ttsAvailable: boolean; // Yapper reachable AND models.tts === true
  ttsEnabled: boolean; // User toggle (persisted in localStorage)
  speaking: boolean; // Audio currently playing
  voices: Voice[]; // Fetched from /v1/voices

  // TTS actions
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  setTtsEnabled: (v: boolean) => void;
  setVoice: (id: string) => void;
  selectedVoice: string; // Current voice ID (persisted in localStorage)
}
```

The health polling already checks `models.tts` — Phase 1 ignores it, Phase 2 uses it to set `ttsAvailable`.

### New: `lib/tts.ts`

Low-level TTS utilities, separated from the hook for testability:

```typescript
/** Split text at sentence boundaries for chunked synthesis. */
export function chunkText(text: string, maxLen?: number): string[];

/** Synthesize a single chunk via Yapper. Returns a WAV Blob. */
export function synthesize(text: string, voice: string, url: string): Promise<Blob>;

/** Play a WAV blob via AudioContext. Returns a handle to stop playback. */
export function playAudio(blob: Blob): { play: () => Promise<void>; stop: () => void };
```

### New: `components/VoiceSettings.tsx`

Rendered in the chat header (or a settings dropdown). Contains:

- Speaker toggle (on/off) — visible only when `ttsAvailable`
- Voice selector dropdown — populated from `voices[]`
- Both persist to localStorage

### Modified: `pages/ChatView.tsx`

Add a `useEffect` that watches `msgState.messages` length. When a new assistant message appears and `ttsEnabled` is true:

```typescript
useEffect(() => {
  if (!voice.ttsEnabled || !voice.ttsAvailable) return;

  const lastMsg = msgState.messages[msgState.messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant') return;

  const text = lastMsg.blocks
    .filter((b) => b.blockType === 'text')
    .map((b) => b.content)
    .join('\n');

  if (text.trim()) voice.speak(text);
}, [msgState.messages.length]);
```

Also: stop speaking when user sends a new message (in `sendMessage` callback).

### Modified: Chat header area

Add `VoiceSettings` component (speaker toggle + voice picker) next to existing header controls.

## File Changes

### New Files

| File                                        | Purpose                                               |
| ------------------------------------------- | ----------------------------------------------------- |
| `frontend/src/lib/tts.ts`                   | Text chunking, synthesis fetch, AudioContext playback |
| `frontend/src/components/VoiceSettings.tsx` | Speaker toggle + voice selector                       |

### Modified Files

| File                              | Change                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `frontend/src/hooks/useVoice.ts`  | Add TTS state, `speak()`, `stopSpeaking()`, voice list fetch, localStorage persistence |
| `frontend/src/pages/ChatView.tsx` | Watch message completion, trigger `speak()`, render VoiceSettings                      |
| `frontend/src/lib/constants.ts`   | Add `TTS_CHUNK_MAX_CHARS`, `TTS_VOICE_KEY`, `TTS_ENABLED_KEY`                          |
| `frontend/src/styles/global.css`  | VoiceSettings and speaker toggle styling                                               |

### Files NOT Modified

- `server/*` — server never sees audio
- `frontend/src/hooks/useChatMessages.ts` — reducer untouched
- `frontend/src/hooks/useChatConnection.ts` — WS pool untouched
- `server/query-loop.ts` — v2 protocol untouched
- `frontend/src/lib/audio.ts` — recording module untouched
- `frontend/src/components/MicButton.tsx` — STT component untouched

## Text Chunking

For responses longer than ~500 characters, split at sentence boundaries and synthesize/play sequentially. This reduces time-to-first-audio and avoids sending huge payloads to Kokoro.

### Algorithm

```
1. Split on sentence-ending punctuation followed by whitespace: /(?<=[.!?])\s+/
2. Merge short fragments (< 20 chars) with the previous chunk
3. Split any remaining chunks that exceed MAX_CHARS at the nearest word boundary
4. Synthesize chunk[0], start playing, synthesize chunk[1] concurrently (pipeline)
```

### Pipelining

To minimize gaps between chunks, use a two-ahead pipeline:

```
Synthesize chunk 1 → Play chunk 1
Synthesize chunk 2 (concurrent with play 1) → Play chunk 2
Synthesize chunk 3 (concurrent with play 2) → Play chunk 3
...
```

If the user interrupts (sends a message, toggles TTS off), cancel all pending synthesis requests and stop the current audio.

## AudioContext Playback

Use `AudioContext` + `AudioBufferSourceNode` rather than `<audio>` element for:

- Precise stop/start control
- No DOM element lifecycle issues
- Better compatibility with mobile auto-play policies (AudioContext can be resumed on user gesture — the TTS toggle tap satisfies this)

```typescript
const ctx = new AudioContext();
const buffer = await ctx.decodeAudioData(wavArrayBuffer);
const source = ctx.createBufferSource();
source.buffer = buffer;
source.connect(ctx.destination);
source.start();
// To stop: source.stop();
```

### Mobile Autoplay

iOS Safari requires `AudioContext` to be created/resumed during a user gesture. The TTS toggle tap satisfies this requirement. We create the `AudioContext` lazily on the first `setTtsEnabled(true)` call.

## Voice Selection

- Fetch voices from `/v1/voices` once on hook mount (if TTS is available)
- Store selected voice ID in localStorage (`mitzo-tts-voice`)
- Default: `af_heart` (Kokoro's default)
- Group by language in the dropdown for readability

## localStorage Keys

| Key                 | Value                | Default      |
| ------------------- | -------------------- | ------------ |
| `mitzo-tts-enabled` | `"true"` / `"false"` | `"false"`    |
| `mitzo-tts-voice`   | voice ID string      | `"af_heart"` |

## Error Handling

| Scenario                          | Behavior                                                                |
| --------------------------------- | ----------------------------------------------------------------------- |
| Yapper 500 on synthesize          | Skip chunk, log warning, continue to next chunk                         |
| Yapper offline mid-playback       | Stop playback, set `ttsAvailable = false`, next health poll may restore |
| AudioContext decode failure       | Skip chunk, log warning                                                 |
| Empty text after filtering blocks | No-op (don't call synthesize with empty string)                         |

No user-visible error toasts for TTS failures — it's a nice-to-have feature, not critical path. Errors are silent with console logging.

## Implementation Plan (TDD)

### Step 1: `tts.ts` — text chunking and synthesis helpers (test-first)

- `chunkText()` with sentence splitting, fragment merging, word-boundary fallback
- `synthesize()` wrapper around fetch to `/v1/synthesize`
- `playAudio()` AudioContext playback with stop handle
- Tests: chunking edge cases, synthesis mock, playback mock

### Step 2: Extend `useVoice.ts` with TTS (test-first)

- `ttsAvailable` derived from health poll `models.tts`
- `ttsEnabled` + `setTtsEnabled` with localStorage
- `voices` fetched from `/v1/voices`
- `selectedVoice` + `setVoice` with localStorage
- `speak(text)` — chunk, pipeline synthesize, play sequentially
- `stopSpeaking()` — cancel pending, stop current audio
- `speaking` state tracking
- Tests: TTS state machine, speak/stop lifecycle, localStorage persistence

### Step 3: `VoiceSettings.tsx` — toggle + voice picker (test-first)

- Speaker icon toggle (visible only when `ttsAvailable`)
- Voice dropdown grouped by language
- Tests: render states, toggle behavior, voice selection

### Step 4: Wire into ChatView

- Effect watching `msgState.messages.length` → auto-speak
- Stop speaking on user send / navigate away
- Render VoiceSettings in header
- Tests: integration — message complete triggers speak, interruption stops playback

### Step 5: CSS + final verification

- VoiceSettings styling (speaker icon, dropdown)
- Full test suite pass
- Manual testing checklist

Each step is test-first, committed atomically. Single PR at the end.

## Open Questions

1. **Should TTS auto-speak on session restore?** Recommendation: no. Only speak newly completed messages, not restored history.
2. **Speed control in UI?** Recommendation: punt. Default speed is fine for MVP. Voice selection is enough customization.
3. **Visual indicator while speaking?** Recommendation: yes, subtle — a small animated speaker icon on the message bubble being spoken. But this is polish, not blocking.
