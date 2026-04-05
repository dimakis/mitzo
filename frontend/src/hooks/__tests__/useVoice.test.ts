// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useVoice } from '../useVoice';
import { YAPPER_HEALTH_POLL_MS } from '../../lib/constants';

// --- Mocks ---

// Mock audio module
vi.mock('../../lib/audio', () => ({
  negotiateMimeType: vi.fn(() => 'audio/webm;codecs=opus'),
  createRecorder: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(() => Promise.resolve(new Blob(['audio'], { type: 'audio/webm' }))),
    cancel: vi.fn(),
    onAutoStop: null,
  })),
  blobToFormData: vi.fn((blob: Blob) => {
    const fd = new FormData();
    fd.append('file', blob);
    return fd;
  }),
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock getUserMedia
const mockGetUserMedia = vi.fn();
const mockStream = {
  getTracks: () => [{ stop: vi.fn(), kind: 'audio' }],
  getAudioTracks: () => [{ stop: vi.fn(), kind: 'audio' }],
} as unknown as MediaStream;

beforeEach(() => {
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: mockGetUserMedia },
    vibrate: vi.fn(),
  });
  mockGetUserMedia.mockResolvedValue(mockStream);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: mock Yapper health response
function mockHealthy(stt = true) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ status: 'ready', models: { stt, tts: false } }),
  });
}

function mockUnhealthy() {
  mockFetch.mockRejectedValueOnce(new Error('Network error'));
}

// --- Tests ---

describe('useVoice', () => {
  describe('health polling', () => {
    it('sets available=true when Yapper is healthy with STT ready', async () => {
      mockHealthy();
      const { result } = renderHook(() => useVoice());

      await waitFor(() => {
        expect(result.current.available).toBe(true);
      });
    });

    it('sets available=false when Yapper is unreachable', async () => {
      mockUnhealthy();
      const { result } = renderHook(() => useVoice());

      await waitFor(() => {
        expect(result.current.available).toBe(false);
      });
    });

    it('sets available=false when STT model is not ready', async () => {
      mockHealthy(false);
      const { result } = renderHook(() => useVoice());

      await waitFor(() => {
        expect(result.current.available).toBe(false);
      });
    });

    it('polls health periodically', async () => {
      vi.useFakeTimers();
      mockHealthy();
      renderHook(() => useVoice());

      // Initial fetch
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // After poll interval
      mockHealthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(YAPPER_HEALTH_POLL_MS);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe('recording', () => {
    it('starts recording after requesting mic permission', async () => {
      mockHealthy();
      const { result } = renderHook(() => useVoice());
      await waitFor(() => expect(result.current.available).toBe(true));

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.recording).toBe(true);
      expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true });
    });

    it('sets micBlocked when permission is denied', async () => {
      mockHealthy();
      mockGetUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
      const { result } = renderHook(() => useVoice());
      await waitFor(() => expect(result.current.available).toBe(true));

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.recording).toBe(false);
      expect(result.current.micBlocked).toBe(true);
    });

    it('stops recording and returns transcript', async () => {
      mockHealthy();
      // Mock transcription response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ text: 'hello world', language: 'en', duration: 1.5 }),
      });

      const { result } = renderHook(() => useVoice());
      await waitFor(() => expect(result.current.available).toBe(true));

      await act(async () => {
        await result.current.startRecording();
      });

      let transcript: string | undefined;
      await act(async () => {
        transcript = await result.current.stopRecording();
      });

      expect(transcript).toBe('hello world');
      expect(result.current.recording).toBe(false);
      expect(result.current.transcribing).toBe(false);
    });

    it('cancel discards recording without transcribing', async () => {
      mockHealthy();
      const { result } = renderHook(() => useVoice());
      await waitFor(() => expect(result.current.available).toBe(true));

      await act(async () => {
        await result.current.startRecording();
      });

      act(() => {
        result.current.cancelRecording();
      });

      expect(result.current.recording).toBe(false);
      // No transcription fetch should have been made (only health check)
      const transcribeCalls = mockFetch.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('/v1/transcribe'),
      );
      expect(transcribeCalls).toHaveLength(0);
    });
  });

  describe('transcription errors', () => {
    it('returns empty string on transcription failure', async () => {
      mockHealthy();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const { result } = renderHook(() => useVoice());
      await waitFor(() => expect(result.current.available).toBe(true));

      await act(async () => {
        await result.current.startRecording();
      });

      let transcript: string | undefined;
      await act(async () => {
        transcript = await result.current.stopRecording();
      });

      expect(transcript).toBe('');
      expect(result.current.error).toBeTruthy();
    });
  });
});
