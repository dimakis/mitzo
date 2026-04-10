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
}));

describe('useDocumentReader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts unavailable before health check', () => {
    // Make fetch hang forever
    global.fetch = vi.fn(() => new Promise(() => {}));
    const { result } = renderHook(() => useDocumentReader());
    expect(result.current.available).toBe(false);
    expect(result.current.state).toBe('idle');
  });

  it('becomes available after successful health check', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ready', models: { stt: true, tts: true } }),
    });

    const { result } = renderHook(() => useDocumentReader());
    // Flush the health check promise
    await act(async () => {});

    expect(result.current.available).toBe(true);
  });

  it('stays unavailable when TTS model is not ready', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ready', models: { stt: true, tts: false } }),
    });

    const { result } = renderHook(() => useDocumentReader());
    await act(async () => {});

    expect(result.current.available).toBe(false);
  });

  it('stays unavailable when health check fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useDocumentReader());
    await act(async () => {});

    expect(result.current.available).toBe(false);
  });

  it('calls synthesizeDocument and playAudio on read()', async () => {
    const { synthesizeDocument, playAudio } = await import('../../lib/tts');
    global.fetch = vi.fn().mockResolvedValue({
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
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ready' }),
    });

    const { result } = renderHook(() => useDocumentReader());
    await act(async () => {});

    await act(async () => {
      result.current.read('Hello');
    });

    act(() => {
      result.current.stop();
    });

    expect(mockPlayHandle.stop).toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });
});
