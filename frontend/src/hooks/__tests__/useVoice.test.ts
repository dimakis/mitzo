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

// Mock tts module
const mockPlayHandle = { play: vi.fn(() => Promise.resolve()), stop: vi.fn() };
vi.mock('../../lib/tts', () => ({
  chunkText: vi.fn((text: string) => (text ? [text] : [])),
  synthesize: vi.fn(() => Promise.resolve(new Blob(['wav'], { type: 'audio/wav' }))),
  playAudio: vi.fn(() => mockPlayHandle),
  getOrCreateAudioContext: vi.fn(() => ({ state: 'running' })),
  closeAudioContext: vi.fn(),
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

  describe('TTS', () => {
    // Helper: health with TTS available
    function mockHealthyWithTts() {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ready', models: { stt: true, tts: true } }),
      });
    }

    it('sets ttsAvailable from health poll models.tts', async () => {
      mockHealthyWithTts();
      const { result } = renderHook(() => useVoice());

      await waitFor(() => {
        expect(result.current.ttsAvailable).toBe(true);
      });
    });

    it('ttsAvailable is false when models.tts is false', async () => {
      mockHealthy(); // stt=true, tts=false
      const { result } = renderHook(() => useVoice());

      await waitFor(() => {
        expect(result.current.available).toBe(true);
        expect(result.current.ttsAvailable).toBe(false);
      });
    });

    it('ttsEnabled defaults to false', async () => {
      mockHealthyWithTts();
      const { result } = renderHook(() => useVoice());

      await waitFor(() => expect(result.current.ttsAvailable).toBe(true));
      expect(result.current.ttsEnabled).toBe(false);
    });

    it('setTtsEnabled toggles and persists to localStorage', async () => {
      mockHealthyWithTts();
      // Mock voices fetch when enabling TTS
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            voices: [
              { id: 'af_heart', name: 'Heart', language: 'American English', gender: 'female' },
            ],
          }),
      });

      const { result } = renderHook(() => useVoice());
      await waitFor(() => expect(result.current.ttsAvailable).toBe(true));

      await act(async () => {
        result.current.setTtsEnabled(true);
      });

      expect(result.current.ttsEnabled).toBe(true);
      expect(localStorage.getItem('mitzo-tts-enabled')).toBe('true');
    });

    it('fetches voices lazily on first setTtsEnabled(true)', async () => {
      mockHealthyWithTts();
      const { result } = renderHook(() => useVoice());
      await waitFor(() => expect(result.current.ttsAvailable).toBe(true));

      // No voices fetch yet
      const voiceFetchesBefore = mockFetch.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('/v1/voices'),
      );
      expect(voiceFetchesBefore).toHaveLength(0);

      // Enable TTS — should fetch voices
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            voices: [
              { id: 'af_heart', name: 'Heart', language: 'American English', gender: 'female' },
              { id: 'am_adam', name: 'Adam', language: 'American English', gender: 'male' },
            ],
          }),
      });

      await act(async () => {
        result.current.setTtsEnabled(true);
      });

      await waitFor(() => {
        expect(result.current.voices).toHaveLength(2);
      });
    });

    it('speak() synthesizes and plays audio', async () => {
      const { synthesize, playAudio } = await import('../../lib/tts');
      mockHealthyWithTts();
      const { result } = renderHook(() => useVoice());
      await waitFor(() => expect(result.current.ttsAvailable).toBe(true));

      await act(async () => {
        await result.current.speak('Hello world');
      });

      expect(synthesize).toHaveBeenCalled();
      expect(playAudio).toHaveBeenCalled();
      expect(mockPlayHandle.play).toHaveBeenCalled();
    });

    it('stopSpeaking() stops current playback', async () => {
      // Make play() hang so we can interrupt it
      let resolvePlay!: () => void;
      mockPlayHandle.play.mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolvePlay = r;
          }),
      );

      mockHealthyWithTts();
      const { result } = renderHook(() => useVoice());
      await waitFor(() => expect(result.current.ttsAvailable).toBe(true));

      // Start speaking (will hang on play)
      let speakDone = false;
      act(() => {
        result.current.speak('Hello world').then(() => {
          speakDone = true;
        });
      });

      // Wait for speaking state
      await waitFor(() => expect(result.current.speaking).toBe(true));

      // Now stop
      act(() => {
        result.current.stopSpeaking();
      });

      expect(mockPlayHandle.stop).toHaveBeenCalled();
      expect(result.current.speaking).toBe(false);

      // Clean up the hanging promise
      resolvePlay();
      await waitFor(() => expect(speakDone).toBe(true));
    });

    it('setVoice persists to localStorage', async () => {
      mockHealthyWithTts();
      const { result } = renderHook(() => useVoice());
      await waitFor(() => expect(result.current.ttsAvailable).toBe(true));

      act(() => {
        result.current.setVoice('am_adam');
      });

      expect(result.current.selectedVoice).toBe('am_adam');
      expect(localStorage.getItem('mitzo-tts-voice')).toBe('am_adam');
    });
  });
});
