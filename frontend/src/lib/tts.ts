// TTS utilities — text chunking, synthesis fetch, AudioContext playback.

import { TTS_CHUNK_MAX_CHARS, TTS_CHUNK_MIN_CHARS, TTS_MAX_SPEAK_CHARS } from './constants';

// --- Pre-processing ---

/** Strip fenced code blocks and inline code so TTS doesn't read raw source. */
export function stripCodeForTts(text: string): string {
  // Remove fenced code blocks (``` ... ```)
  let result = text.replace(/```[\s\S]*?```/g, '');
  // Strip backticks from inline code but keep the text (``code`` and `code`)
  result = result.replace(/``([^`]+)``/g, '$1');
  result = result.replace(/`([^`]+)`/g, '$1');
  // Collapse multiple blank lines left behind
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

/** Truncate text to TTS_MAX_SPEAK_CHARS at a word boundary. */
export function truncateForTts(text: string, max = TTS_MAX_SPEAK_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, max)) + '...';
}

// --- Text chunking ---

/** Split text at sentence boundaries for chunked synthesis. */
export function chunkText(text: string, maxLen = TTS_CHUNK_MAX_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Split on sentence-ending punctuation followed by whitespace
  const raw = trimmed.split(/(?<=[.!?])\s+/);

  // Merge short fragments with previous chunk
  const merged: string[] = [];
  for (const fragment of raw) {
    if (merged.length > 0 && fragment.length < TTS_CHUNK_MIN_CHARS) {
      merged[merged.length - 1] += ' ' + fragment;
    } else {
      merged.push(fragment);
    }
  }

  // Split overlong chunks at word boundaries
  const result: string[] = [];
  for (const chunk of merged) {
    if (chunk.length <= maxLen) {
      result.push(chunk);
    } else {
      splitAtWordBoundary(chunk, maxLen, result);
    }
  }

  return result;
}

function splitAtWordBoundary(text: string, maxLen: number, out: string[]): void {
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf(' ', maxLen);
    if (splitIdx <= 0) splitIdx = maxLen; // no space found, hard split
    out.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining) out.push(remaining);
}

// --- Synthesis ---

/** Synthesize text via Yapper. Accepts AbortSignal for cancellation. */
export async function synthesize(
  text: string,
  voice: string,
  url: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch(`${url}/v1/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Synthesis failed (${res.status})`);
  }

  return res.blob();
}

// --- AudioContext singleton ---

let audioCtx: AudioContext | null = null;

/** Get or create the shared AudioContext. Reuse is mandatory (browser caps at ~6). */
export function getOrCreateAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * Unlock the AudioContext for iOS Safari.
 *
 * iOS requires audio to be played during a user gesture to "unlock" the context.
 * Call this when the user toggles TTS on — it plays a tiny silent buffer so that
 * later programmatic playback (when assistant messages arrive) is not blocked.
 */
export async function unlockAudioContext(): Promise<void> {
  const ctx = getOrCreateAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
}

/** Close and release the shared AudioContext. Call on unmount. */
export function closeAudioContext(): void {
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}

// --- Playback ---

/** Play a WAV blob via the shared AudioContext. Returns a handle to stop playback. */
export function playAudio(blob: Blob): { play: () => Promise<void>; stop: () => void } {
  let source: AudioBufferSourceNode | null = null;
  let stopped = false;
  let started = false;

  return {
    async play() {
      if (started || stopped) return;
      started = true;
      const ctx = getOrCreateAudioContext();
      if (ctx.state === 'suspended') await ctx.resume();

      const arrayBuffer = await blob.arrayBuffer();
      const buffer = await ctx.decodeAudioData(arrayBuffer);

      if (stopped) return;

      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      return new Promise<void>((resolve) => {
        source!.onended = () => resolve();
        source!.start();
      });
    },

    stop() {
      stopped = true;
      try {
        source?.stop();
      } catch {
        // Already stopped or not started
      }
    },
  };
}
