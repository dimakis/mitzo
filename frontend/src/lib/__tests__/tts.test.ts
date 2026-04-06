import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  chunkText,
  stripCodeForTts,
  truncateForTts,
  synthesize,
  getOrCreateAudioContext,
  closeAudioContext,
  playAudio,
} from '../tts';
import { TTS_CHUNK_MAX_CHARS, TTS_MAX_SPEAK_CHARS } from '../constants';

// --- Mocks ---

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Minimal AudioContext mock
class MockAudioBufferSourceNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn(() => {
    // Simulate playback ending
    setTimeout(() => this.onended?.(), 10);
  });
  stop = vi.fn();
}

class MockAudioContext {
  state = 'running';
  decodeAudioData = vi.fn(() => Promise.resolve({ duration: 1, length: 44100, sampleRate: 44100 }));
  createBufferSource = vi.fn(() => new MockAudioBufferSourceNode());
  destination = {};
  close = vi.fn();
  resume = vi.fn(() => Promise.resolve());
}

beforeEach(() => {
  vi.stubGlobal('AudioContext', MockAudioContext);
  mockFetch.mockReset();
  closeAudioContext(); // ensure clean state
});

afterEach(() => {
  closeAudioContext();
  vi.restoreAllMocks();
});

// --- chunkText ---

describe('chunkText', () => {
  it('returns single chunk for short text', () => {
    expect(chunkText('Hello world.')).toEqual(['Hello world.']);
  });

  it('splits on sentence boundaries', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const chunks = chunkText(text);
    expect(chunks).toEqual(['First sentence.', 'Second sentence.', 'Third sentence.']);
  });

  it('splits on exclamation and question marks', () => {
    const text = 'What do you think? Absolutely! That sounds great.';
    expect(chunkText(text)).toEqual(['What do you think?', 'Absolutely!', 'That sounds great.']);
  });

  it('merges very short fragments with previous', () => {
    const text = 'Really? Yes! Okay.';
    // "Yes!" (4 chars) and "Okay." (5 chars) are too short to stand alone
    expect(chunkText(text)).toEqual(['Really? Yes! Okay.']);
  });

  it('merges short fragments with previous chunk', () => {
    // "No." is < 20 chars, should merge with previous
    const text = 'This is a full sentence. No.';
    const chunks = chunkText(text);
    expect(chunks).toEqual(['This is a full sentence. No.']);
  });

  it('splits long chunks at word boundaries', () => {
    const longSentence = 'word '.repeat(200).trim() + '.';
    const chunks = chunkText(longSentence);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TTS_CHUNK_MAX_CHARS + 50); // some tolerance
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('handles empty string', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('handles whitespace-only string', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('handles single word', () => {
    expect(chunkText('Hello')).toEqual(['Hello']);
  });
});

// --- stripCodeForTts ---

describe('stripCodeForTts', () => {
  it('removes fenced code blocks', () => {
    const text = 'Here is code:\n```js\nconsole.log("hi");\n```\nDone.';
    expect(stripCodeForTts(text)).toBe('Here is code:\n\nDone.');
  });

  it('removes inline code', () => {
    expect(stripCodeForTts('Use `useState` for state.')).toBe('Use  for state.');
  });

  it('handles multiple code blocks', () => {
    const text = 'A\n```\nfoo\n```\nB\n```\nbar\n```\nC';
    expect(stripCodeForTts(text)).toBe('A\n\nB\n\nC');
  });

  it('returns plain text unchanged', () => {
    expect(stripCodeForTts('Hello world.')).toBe('Hello world.');
  });

  it('handles empty string', () => {
    expect(stripCodeForTts('')).toBe('');
  });
});

// --- truncateForTts ---

describe('truncateForTts', () => {
  it('returns short text unchanged', () => {
    expect(truncateForTts('Hello.')).toBe('Hello.');
  });

  it('truncates at word boundary with ellipsis', () => {
    const text = 'word '.repeat(500).trim();
    const result = truncateForTts(text);
    expect(result.length).toBeLessThanOrEqual(TTS_MAX_SPEAK_CHARS + 5);
    expect(result.endsWith('...')).toBe(true);
  });

  it('respects custom max', () => {
    const result = truncateForTts('one two three four five', 10);
    expect(result).toBe('one two...');
  });
});

// --- synthesize ---

describe('synthesize', () => {
  it('fetches from Yapper with correct params', async () => {
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    mockFetch.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(blob) });

    const result = await synthesize('hello', 'af_heart', 'http://localhost:8700');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8700/v1/synthesize',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello', voice: 'af_heart' }),
      }),
    );
    expect(result).toBe(blob);
  });

  it('passes AbortSignal when provided', async () => {
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    mockFetch.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(blob) });
    const controller = new AbortController();

    await synthesize('hello', 'af_heart', 'http://localhost:8700', controller.signal);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8700/v1/synthesize',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('throws on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(synthesize('hello', 'af_heart', 'http://localhost:8700')).rejects.toThrow(
      'Synthesis failed (500)',
    );
  });
});

// --- AudioContext management ---

describe('AudioContext management', () => {
  it('creates AudioContext lazily', () => {
    const ctx = getOrCreateAudioContext();
    expect(ctx).toBeInstanceOf(MockAudioContext);
  });

  it('reuses the same AudioContext instance', () => {
    const ctx1 = getOrCreateAudioContext();
    const ctx2 = getOrCreateAudioContext();
    expect(ctx1).toBe(ctx2);
  });

  it('closeAudioContext releases and allows recreation', () => {
    const ctx1 = getOrCreateAudioContext();
    closeAudioContext();
    const ctx2 = getOrCreateAudioContext();
    expect(ctx2).not.toBe(ctx1);
    expect(ctx1.close).toHaveBeenCalled();
  });
});

// --- playAudio ---

describe('playAudio', () => {
  it('decodes and plays audio blob', async () => {
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    const handle = playAudio(blob);

    await handle.play();
    // Should have decoded and started playback
    const ctx = getOrCreateAudioContext() as unknown as MockAudioContext;
    expect(ctx.decodeAudioData).toHaveBeenCalled();
  });

  it('stop() halts playback', async () => {
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    const handle = playAudio(blob);

    const playPromise = handle.play();
    handle.stop();
    await playPromise;
    // Should not throw
  });

  it('play() is idempotent — second call is a no-op', async () => {
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    const handle = playAudio(blob);

    await handle.play();
    const ctx = getOrCreateAudioContext() as unknown as MockAudioContext;
    const callCount = ctx.decodeAudioData.mock.calls.length;

    // Second play should not decode again
    await handle.play();
    expect(ctx.decodeAudioData.mock.calls.length).toBe(callCount);
  });
});
