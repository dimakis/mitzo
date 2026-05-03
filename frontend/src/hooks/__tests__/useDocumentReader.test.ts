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
  DEFAULT_TTS_VOICE: 'af_heart',
  DOCUMENT_READ_MAX_CHARS: 50_000,
}));

// Mock useServiceHealth — control yapper status per test
let mockYapper: { ok: boolean; detail?: Record<string, unknown> } | null = null;
vi.mock('../useServiceHealth', () => ({
  useServiceHealth: () => ({
    services: mockYapper ? [mockYapper] : [],
    yapper: mockYapper,
    contexgin: null,
    checkedAt: mockYapper ? Date.now() : 0,
  }),
}));

const mockFetch = vi.fn();

describe('useDocumentReader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockYapper = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts unavailable when no health data', () => {
    mockYapper = null;
    const { result } = renderHook(() => useDocumentReader());
    expect(result.current.available).toBe(false);
    expect(result.current.state).toBe('idle');
  });

  it('becomes available when yapper health reports ok with tts', () => {
    mockYapper = { ok: true, detail: { stt: true, tts: true } };
    const { result } = renderHook(() => useDocumentReader());
    expect(result.current.available).toBe(true);
  });

  it('stays unavailable when TTS model is not ready', () => {
    mockYapper = { ok: true, detail: { stt: true, tts: false } };
    const { result } = renderHook(() => useDocumentReader());
    expect(result.current.available).toBe(false);
  });

  it('stays unavailable when yapper is down', () => {
    mockYapper = { ok: false };
    const { result } = renderHook(() => useDocumentReader());
    expect(result.current.available).toBe(false);
  });

  it('calls synthesizeDocument and playAudio on read()', async () => {
    const { synthesizeDocument, playAudio } = await import('../../lib/tts');
    mockYapper = { ok: true, detail: { tts: true } };

    const { result } = renderHook(() => useDocumentReader());

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
    mockPlayHandle.play.mockReturnValue(new Promise(() => {}));
    mockYapper = { ok: true, detail: { tts: true } };

    const { result } = renderHook(() => useDocumentReader());

    act(() => {
      result.current.read('Hello');
    });

    await act(async () => {});

    expect(result.current.state).toBe('playing');

    act(() => {
      result.current.stop();
    });

    expect(mockPlayHandle.stop).toHaveBeenCalled();
    expect(result.current.state).toBe('idle');

    mockPlayHandle.play.mockResolvedValue(undefined);
  });
});
