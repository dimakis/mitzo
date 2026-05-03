// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useVoice } from '../useVoice';

// --- Mocks ---

// Mock streaming recorder
const mockStreamingRecorder = {
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  onChunk: null as ((data: Blob) => void) | null,
  onStop: null as (() => void) | null,
  onAutoStop: null as (() => void) | null,
};

// Mock audio module
vi.mock('../../lib/audio', () => ({
  negotiateMimeType: vi.fn(() => 'audio/webm;codecs=opus'),
  createRecorder: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(() => Promise.resolve(new Blob(['audio'], { type: 'audio/webm' }))),
    cancel: vi.fn(),
    onAutoStop: null,
  })),
  createStreamingRecorder: vi.fn(() => mockStreamingRecorder),
  blobToFormData: vi.fn((blob: Blob) => {
    const fd = new FormData();
    fd.append('file', blob);
    return fd;
  }),
}));

// Mock yapper-ws
const mockWsClient = {
  sendFormat: vi.fn(),
  sendAudio: vi.fn(),
  sendEnd: vi.fn(),
  close: vi.fn(),
  onTranscript: null as ((e: { type: string; text: string }) => void) | null,
  onError: null as ((e: Event) => void) | null,
};

vi.mock('../../lib/yapper-ws', () => ({
  createYapperStreamClient: vi.fn(() => mockWsClient),
}));

// Mock tts module
const mockPlayHandle = { play: vi.fn(() => Promise.resolve()), stop: vi.fn() };
vi.mock('../../lib/tts', () => ({
  chunkText: vi.fn((text: string) => (text ? [text] : [])),
  synthesize: vi.fn(() => Promise.resolve(new Blob(['wav'], { type: 'audio/wav' }))),
  playAudio: vi.fn(() => mockPlayHandle),
  getOrCreateAudioContext: vi.fn(() => ({ state: 'running' })),
  closeAudioContext: vi.fn(),
  unlockAudioContext: vi.fn(() => Promise.resolve()),
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

// Mock fetch (still needed for transcription + voice list)
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
  mockYapper = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Tests ---

describe('useVoice', () => {
  describe('SSE-driven health', () => {
    it('sets available=true when yapper is healthy with STT ready', () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());
      expect(result.current.available).toBe(true);
    });

    it('sets available=false when yapper is null', () => {
      mockYapper = null;
      const { result } = renderHook(() => useVoice());
      expect(result.current.available).toBe(false);
    });

    it('sets available=false when STT model is not ready', () => {
      mockYapper = { ok: true, detail: { stt: false, tts: true } };
      const { result } = renderHook(() => useVoice());
      expect(result.current.available).toBe(false);
    });

    it('sets ttsAvailable from yapper detail', () => {
      mockYapper = { ok: true, detail: { stt: true, tts: true } };
      const { result } = renderHook(() => useVoice());
      expect(result.current.ttsAvailable).toBe(true);
    });

    it('ttsAvailable is false when models.tts is false', () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());
      expect(result.current.ttsAvailable).toBe(false);
    });
  });

  describe('recording', () => {
    it('starts recording after requesting mic permission', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.recording).toBe(true);
      expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true });
    });

    it('sets micBlocked when permission is denied', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      mockGetUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.recording).toBe(false);
      expect(result.current.micBlocked).toBe(true);
    });

    it('stops recording and returns transcript', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      let transcript: string | undefined;
      let stopPromise: Promise<string>;
      act(() => {
        stopPromise = result.current.stopRecording();
      });

      act(() => {
        mockWsClient.onTranscript?.({ type: 'final', text: 'hello world' });
      });

      await act(async () => {
        transcript = await stopPromise!;
      });

      expect(transcript).toBe('hello world');
      expect(result.current.recording).toBe(false);
    });

    it('cancel discards recording without transcribing', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      act(() => {
        result.current.cancelRecording();
      });

      expect(result.current.recording).toBe(false);
      const transcribeCalls = mockFetch.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('/v1/transcribe'),
      );
      expect(transcribeCalls).toHaveLength(0);
    });
  });

  describe('transcription errors', () => {
    it('returns empty string on batch transcription failure', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };

      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      act(() => {
        mockWsClient.onError?.(new Event('error'));
      });

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      let transcript: string | undefined;
      await act(async () => {
        transcript = await result.current.stopRecording();
      });

      expect(transcript).toBe('');
      expect(result.current.error).toBeTruthy();
    });
  });

  describe('streaming STT', () => {
    it('uses streaming recorder + WS client when available', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      expect(result.current.recording).toBe(true);
      expect(mockStreamingRecorder.start).toHaveBeenCalled();
    });

    it('shows partial transcript from WS partial events', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      act(() => {
        mockWsClient.onTranscript?.({ type: 'partial', text: 'hello' });
      });

      expect(result.current.partialTranscript).toBe('hello');
    });

    it('updates partial transcript on each new partial', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      act(() => {
        mockWsClient.onTranscript?.({ type: 'partial', text: 'hel' });
      });
      expect(result.current.partialTranscript).toBe('hel');

      act(() => {
        mockWsClient.onTranscript?.({ type: 'partial', text: 'hello wor' });
      });
      expect(result.current.partialTranscript).toBe('hello wor');
    });

    it('stopRecording sends END and returns final transcript', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      act(() => {
        mockWsClient.onTranscript?.({ type: 'partial', text: 'hello' });
      });

      let transcriptPromise: Promise<string>;
      act(() => {
        transcriptPromise = result.current.stopRecording();
      });

      act(() => {
        mockWsClient.onTranscript?.({ type: 'final', text: 'hello world' });
      });

      const transcript = await transcriptPromise!;
      expect(transcript).toBe('hello world');
      expect(mockWsClient.sendEnd).toHaveBeenCalled();
      expect(mockStreamingRecorder.stop).toHaveBeenCalled();
      expect(result.current.recording).toBe(false);
      await waitFor(() => {
        expect(result.current.partialTranscript).toBe('');
      });
    });

    it('sends audio chunks to WS as they arrive', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      const chunkBlob = new Blob(['audio-chunk'], { type: 'audio/webm' });
      await act(async () => {
        mockStreamingRecorder.onChunk?.(chunkBlob);
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(mockWsClient.sendAudio).toHaveBeenCalled();
    });

    it('sends format frame before audio', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      expect(mockWsClient.sendFormat).toHaveBeenCalledWith('webm/opus');
    });

    it('cancelRecording closes WS and clears partial', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      act(() => {
        mockWsClient.onTranscript?.({ type: 'partial', text: 'hel' });
      });
      expect(result.current.partialTranscript).toBe('hel');

      act(() => {
        result.current.cancelRecording();
      });

      expect(result.current.recording).toBe(false);
      expect(result.current.partialTranscript).toBe('');
      expect(mockWsClient.close).toHaveBeenCalled();
      expect(mockStreamingRecorder.cancel).toHaveBeenCalled();
    });

    it('falls back to batch on WS error during recording', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: false } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ text: 'batch fallback', language: 'en', duration: 1.0 }),
      });

      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.startRecording();
      });

      act(() => {
        mockWsClient.onError?.(new Event('error'));
      });

      let transcript: string | undefined;
      await act(async () => {
        transcript = await result.current.stopRecording();
      });

      expect(transcript).toBe('batch fallback');
    });
  });

  describe('TTS', () => {
    it('ttsEnabled defaults to false', () => {
      mockYapper = { ok: true, detail: { stt: true, tts: true } };
      const { result } = renderHook(() => useVoice());
      expect(result.current.ttsEnabled).toBe(false);
    });

    it('setTtsEnabled toggles and persists to localStorage', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: true } };
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

      await act(async () => {
        result.current.setTtsEnabled(true);
      });

      expect(result.current.ttsEnabled).toBe(true);
      expect(localStorage.getItem('mitzo-tts-enabled')).toBe('true');
    });

    it('fetches voices lazily on first setTtsEnabled(true)', async () => {
      mockYapper = { ok: true, detail: { stt: true, tts: true } };
      const { result } = renderHook(() => useVoice());

      const voiceFetchesBefore = mockFetch.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('/v1/voices'),
      );
      expect(voiceFetchesBefore).toHaveLength(0);

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

    it('registers interaction listener to unlock AudioContext when ttsEnabled is pre-set', async () => {
      const { getOrCreateAudioContext, unlockAudioContext } = await import('../../lib/tts');
      const mockCtx = getOrCreateAudioContext as ReturnType<typeof vi.fn>;
      const mockUnlock = unlockAudioContext as ReturnType<typeof vi.fn>;
      mockUnlock.mockClear();

      mockCtx.mockReturnValue({ state: 'suspended' });

      localStorage.setItem('mitzo-tts-enabled', 'true');

      mockYapper = { ok: true, detail: { stt: true, tts: true } };
      renderHook(() => useVoice());
      await waitFor(() => {});

      expect(mockUnlock).not.toHaveBeenCalled();

      document.dispatchEvent(new Event('click'));

      expect(mockUnlock).toHaveBeenCalledTimes(1);

      mockCtx.mockReturnValue({ state: 'running' });
    });

    it('unlocks AudioContext on touchstart (iOS Safari primary path)', async () => {
      const { getOrCreateAudioContext, unlockAudioContext } = await import('../../lib/tts');
      const mockCtx = getOrCreateAudioContext as ReturnType<typeof vi.fn>;
      const mockUnlock = unlockAudioContext as ReturnType<typeof vi.fn>;
      mockUnlock.mockClear();

      mockCtx.mockReturnValue({ state: 'suspended' });
      localStorage.setItem('mitzo-tts-enabled', 'true');

      mockYapper = { ok: true, detail: { stt: true, tts: true } };
      renderHook(() => useVoice());
      await waitFor(() => {});

      document.dispatchEvent(new Event('touchstart'));

      expect(mockUnlock).toHaveBeenCalledTimes(1);

      mockUnlock.mockClear();
      document.dispatchEvent(new Event('touchstart'));
      expect(mockUnlock).not.toHaveBeenCalled();

      mockCtx.mockReturnValue({ state: 'running' });
    });

    it('skips interaction listener when AudioContext is already running', async () => {
      const { getOrCreateAudioContext, unlockAudioContext } = await import('../../lib/tts');
      const mockCtx = getOrCreateAudioContext as ReturnType<typeof vi.fn>;
      const mockUnlock = unlockAudioContext as ReturnType<typeof vi.fn>;
      mockUnlock.mockClear();

      mockCtx.mockReturnValue({ state: 'running' });

      localStorage.setItem('mitzo-tts-enabled', 'true');

      mockYapper = { ok: true, detail: { stt: true, tts: true } };
      renderHook(() => useVoice());
      await waitFor(() => {});

      document.dispatchEvent(new Event('click'));
      expect(mockUnlock).not.toHaveBeenCalled();
    });

    it('setTtsEnabled(true) calls unlockAudioContext for iOS Safari', async () => {
      const { unlockAudioContext } = await import('../../lib/tts');
      mockYapper = { ok: true, detail: { stt: true, tts: true } };
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

      await act(async () => {
        result.current.setTtsEnabled(true);
      });

      expect(unlockAudioContext).toHaveBeenCalled();
    });

    it('speak() synthesizes and plays audio', async () => {
      const { synthesize, playAudio } = await import('../../lib/tts');
      mockYapper = { ok: true, detail: { stt: true, tts: true } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.speak('Hello world');
      });

      expect(synthesize).toHaveBeenCalled();
      expect(playAudio).toHaveBeenCalled();
      expect(mockPlayHandle.play).toHaveBeenCalled();
    });

    it('stopSpeaking() stops current playback', async () => {
      let resolvePlay!: () => void;
      mockPlayHandle.play.mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolvePlay = r;
          }),
      );

      mockYapper = { ok: true, detail: { stt: true, tts: true } };
      const { result } = renderHook(() => useVoice());

      let speakDone = false;
      act(() => {
        result.current.speak('Hello world').then(() => {
          speakDone = true;
        });
      });

      await waitFor(() => expect(result.current.speaking).toBe(true));

      act(() => {
        result.current.stopSpeaking();
      });

      expect(mockPlayHandle.stop).toHaveBeenCalled();
      expect(result.current.speaking).toBe(false);

      resolvePlay();
      await waitFor(() => expect(speakDone).toBe(true));
    });

    it('continues playing remaining chunks when one chunk fails', async () => {
      const { chunkText, synthesize, playAudio } = await import('../../lib/tts');
      const mockChunk = chunkText as ReturnType<typeof vi.fn>;
      const mockSynth = synthesize as ReturnType<typeof vi.fn>;
      const mockPlayAudio = playAudio as ReturnType<typeof vi.fn>;

      mockSynth.mockClear();
      mockPlayAudio.mockClear();

      mockChunk.mockReturnValueOnce(['chunk1', 'chunk2', 'chunk3']);
      const goodBlob = new Blob(['wav'], { type: 'audio/wav' });
      mockSynth
        .mockResolvedValueOnce(goodBlob)
        .mockRejectedValueOnce(new Error('Synthesis failed (500)'))
        .mockResolvedValueOnce(goodBlob);

      mockYapper = { ok: true, detail: { stt: true, tts: true } };
      const { result } = renderHook(() => useVoice());

      await act(async () => {
        await result.current.speak('some long text');
      });

      expect(mockSynth).toHaveBeenCalledTimes(3);
      expect(mockPlayAudio).toHaveBeenCalledTimes(2);
    });

    it('setVoice persists to localStorage', () => {
      mockYapper = { ok: true, detail: { stt: true, tts: true } };
      const { result } = renderHook(() => useVoice());

      act(() => {
        result.current.setVoice('am_adam');
      });

      expect(result.current.selectedVoice).toBe('am_adam');
      expect(localStorage.getItem('mitzo-tts-voice')).toBe('am_adam');
    });
  });
});
