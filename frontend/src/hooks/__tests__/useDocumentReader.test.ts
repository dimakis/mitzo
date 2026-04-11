// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDocumentReader } from '../useDocumentReader';

// Mock tts module
const mockPlayHandle = { play: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
vi.mock('../../lib/tts', () => ({
  synthesizeDocument: vi.fn().mockResolvedValue(new Blob(['audio'])),
  playAudio: vi.fn(() => mockPlayHandle),
  unlockAudioContext: vi.fn().mockResolvedValue(undefined),
}));

// Mock constants
vi.mock('../../lib/constants', () => ({
  YAPPER_URL: 'http://test-yapper',
  YAPPER_HEALTH_POLL_MS: 30000,
  DEFAULT_TTS_VOICE: 'af_heart',
  DOCUMENT_READ_MAX_CHARS: 50_000,
}));

const mockFetch = vi.fn();

describe('useDocumentReader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts unavailable before health check', () => {
    // Make fetch hang forever
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useDocumentReader());
    expect(result.current.available).toBe(false);
    expect(result.current.state).toBe('idle');
  });

  it('becomes available after successful health check', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ready', models: { stt: true, tts: true } }),
    });

    const { result } = renderHook(() => useDocumentReader());
    await act(async () => {});

    expect(result.current.available).toBe(true);
  });

  it('stays unavailable when TTS model is not ready', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ready', models: { stt: true, tts: false } }),
    });

    const { result } = renderHook(() => useDocumentReader());
    await act(async () => {});

    expect(result.current.available).toBe(false);
  });

  it('stays unavailable when health check fails', async () => {
    mockFetch.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useDocumentReader());
    await act(async () => {});

    expect(result.current.available).toBe(false);
  });

  it('calls synthesizeDocument and playAudio on read()', async () => {
    const { synthesizeDocument, playAudio } = await import('../../lib/tts');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ready' }),
    });

    const { result } = renderHook(() => useDocumentReader());
    await act(async () => {});

    await act(async () => {
      result.current.read('# Hello\n\nWorld');
    });

    expect(synthesizeDocument).toHaveBeenCalledWith(
      '# Hello\n\nWorld',
      'af_heart',
      'http://test-yapper',
      expect.any(AbortSignal),
    );
    expect(playAudio).toHaveBeenCalled();
    expect(mockPlayHandle.play).toHaveBeenCalled();
  });

  it('stops playback on stop()', async () => {
    // Make play() hang so state stays 'playing' until stop() is called
    mockPlayHandle.play.mockReturnValue(new Promise(() => {}));

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ready' }),
    });

    const { result } = renderHook(() => useDocumentReader());
    await act(async () => {});

    act(() => {
      result.current.read('Hello');
    });

    // Flush async pipeline up to playAudio()
    await act(async () => {});

    expect(result.current.state).toBe('playing');

    act(() => {
      result.current.stop();
    });

    expect(mockPlayHandle.stop).toHaveBeenCalled();
    expect(result.current.state).toBe('idle');

    // Restore default mock for other tests
    mockPlayHandle.play.mockResolvedValue(undefined);
  });
});
