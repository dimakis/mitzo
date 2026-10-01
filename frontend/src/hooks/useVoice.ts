// Voice integration hook — Yapper health, mic capture, streaming + batch transcription, TTS playback.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  YAPPER_URL,
  TTS_VOICE_KEY,
  TTS_VOICES_RETRY_DELAY_MS,
  DEFAULT_TTS_VOICE,
} from '../lib/constants';
import { useServiceHealth } from './useServiceHealth';
import {
  negotiateMimeType,
  createRecorder,
  createStreamingRecorder,
  blobToFormData,
  type Recorder,
  type StreamingRecorder,
} from '../lib/audio';
import { createYapperStreamClient, type YapperStreamClient } from '../lib/yapper-ws';
import {
  chunkText,
  synthesize,
  playAudio,
  unlockAudioContext,
  closeAudioContext,
} from '../lib/tts';

export interface Voice {
  id: string;
  name: string;
  language: string;
  gender: string;
}

export interface UseVoiceReturn {
  // STT state
  available: boolean;
  recording: boolean;
  transcribing: boolean;
  micBlocked: boolean;
  error: string | null;

  partialTranscript: string;

  // STT actions
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string>;
  cancelRecording: () => void;

  // TTS state
  ttsAvailable: boolean;
  speaking: boolean;
  voices: Voice[];
  selectedVoice: string;

  // TTS actions
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  setVoice: (id: string) => void;
}

/** Map mimeType to Yapper format string. */
function mimeToFormat(mime: string): string {
  if (mime.includes('opus')) return 'webm/opus';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  return 'webm';
}

export function useVoice(): UseVoiceReturn {
  // --- Service health (SSE-driven) ---
  const { yapper } = useServiceHealth();
  // detail?.stt !== false: when Yapper omits `models`, detail is undefined
  // and we assume both capabilities (matches old per-hook polling behavior).
  // Server sets ok=false for non-ready statuses, so this only fires when healthy.
  const available = yapper?.ok === true && yapper.detail?.stt !== false;
  const ttsAvailable = yapper?.ok === true && yapper.detail?.tts !== false;

  // --- STT state ---
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micBlocked, setMicBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState(
    () => localStorage.getItem(TTS_VOICE_KEY) || DEFAULT_TTS_VOICE,
  );

  const [partialTranscript, setPartialTranscriptState] = useState('');
  const partialRef = useRef('');
  const setPartialTranscript = useCallback((text: string) => {
    partialRef.current = text;
    setPartialTranscriptState(text);
  }, []);

  const recorderRef = useRef<Recorder | null>(null);
  const streamRecorderRef = useRef<StreamingRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const wsClientRef = useRef<YapperStreamClient | null>(null);
  const finalResolveRef = useRef<((text: string | null) => void) | null>(null);
  const streamingActiveRef = useRef(false);
  const captureDoneRef = useRef<Promise<void>>(Promise.resolve());
  const resolveCaptureDoneRef = useRef<(() => void) | null>(null);
  const audioSendRef = useRef<Promise<void>>(Promise.resolve());
  const captureIdRef = useRef(0);
  const mimeTypeRef = useRef<string | undefined>(undefined);
  const voicesFetchedRef = useRef(false);
  const voicesFetchRef = useRef<Promise<boolean> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const currentPlayRef = useRef<{ stop: () => void } | null>(null);

  // --- Negotiate mime type once ---
  useEffect(() => {
    try {
      mimeTypeRef.current = negotiateMimeType();
    } catch {
      // MediaRecorder not available (SSR, old browser)
    }
  }, []);

  // --- Cleanup AudioContext on unmount ---
  useEffect(() => {
    return () => {
      closeAudioContext();
    };
  }, []);

  // --- Helper: release the shared MediaStream ---
  const releaseStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
  }, []);

  // --- STT: Recording (streaming with batch fallback) ---
  const startRecording = useCallback(async () => {
    const captureId = ++captureIdRef.current;
    setError(null);
    setPartialTranscript('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (captureId !== captureIdRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStreamRef.current = stream;
      const mimeType = mimeTypeRef.current;
      if (!mimeType) {
        setError('No supported audio format');
        releaseStream();
        return;
      }

      // Try streaming path: streaming recorder + WS client
      // HTTP proxy is at /api/yapper; WS proxy is at /api/yapper-ws
      const wsUrl =
        YAPPER_URL.replace(/^http/, 'ws').replace('/api/yapper', '/api/yapper-ws') +
        '/v1/transcribe/stream';
      const wsClient = createYapperStreamClient(wsUrl);
      wsClientRef.current = wsClient;
      streamingActiveRef.current = true;

      // Wire up transcript events
      wsClient.onTranscript = (event) => {
        if (captureId !== captureIdRef.current) return;
        if (event.type === 'partial') {
          setPartialTranscript(event.text);
        } else if (event.type === 'final') {
          // Resolve the pending stopRecording promise
          finalResolveRef.current?.(event.text);
          finalResolveRef.current = null;
        }
      };

      wsClient.onError = () => {
        if (captureId !== captureIdRef.current) return;
        // Mark streaming as failed — stopRecording will use batch fallback
        streamingActiveRef.current = false;
        finalResolveRef.current?.(null);
      };

      // Send format frame
      wsClient.sendFormat(mimeToFormat(mimeType));

      // Store the stream — the hook owns track cleanup, not the recorders
      mediaStreamRef.current = stream;

      // Create streaming recorder (doesn't own stream)
      const streamRec = createStreamingRecorder(stream, mimeType, { ownsStream: false });
      streamRecorderRef.current = streamRec;

      // Also create a batch recorder as fallback (doesn't own stream)
      const batchRec = createRecorder(stream, mimeType, { ownsStream: false });
      batchRec.onAutoStop = () => setRecording(false);
      recorderRef.current = batchRec;

      // MediaRecorder emits its last dataavailable asynchronously before onStop.
      // Serialize conversions too: Blob.arrayBuffer() may finish out of order.
      audioSendRef.current = Promise.resolve();
      captureDoneRef.current = new Promise<void>((resolve) => {
        resolveCaptureDoneRef.current = resolve;
        streamRec.onStop = resolve;
      });
      streamRec.onChunk = (blob: Blob) => {
        audioSendRef.current = audioSendRef.current
          .then(async () => {
            const buf = await blob.arrayBuffer();
            if (captureId === captureIdRef.current && streamingActiveRef.current) {
              wsClient.sendAudio(buf);
            }
          })
          .catch(() => {
            if (captureId === captureIdRef.current) wsClient.onError?.(new Event('error'));
          });
      };

      streamRec.onAutoStop = () => setRecording(false);

      streamRec.start();
      batchRec.start();
      setRecording(true);
      setMicBlocked(false);
    } catch (err: unknown) {
      streamRecorderRef.current?.cancel();
      recorderRef.current?.cancel();
      wsClientRef.current?.close();
      releaseStream();
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setMicBlocked(true);
      } else {
        setError(err instanceof Error ? err.message : 'Mic access failed');
      }
    }
  }, [releaseStream, setPartialTranscript]);

  const stopRecording = useCallback(async (): Promise<string> => {
    setRecording(false);
    setError(null);

    const captureId = captureIdRef.current;
    setTranscribing(true);

    // Register the final listener before END, and only end after the last chunk.
    if (streamingActiveRef.current && wsClientRef.current) {
      const client = wsClientRef.current;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const final = new Promise<string | null>((resolve) => {
        finalResolveRef.current = resolve;
        timer = setTimeout(() => resolve(null), 5000);
      });
      streamRecorderRef.current?.stop();
      await captureDoneRef.current;
      await audioSendRef.current;
      if (captureId !== captureIdRef.current) return '';
      if (streamingActiveRef.current) client.sendEnd();
      else finalResolveRef.current?.(null);
      const text = await final;
      clearTimeout(timer);
      finalResolveRef.current = null;
      if (captureId !== captureIdRef.current) return '';
      if (text !== null) {
        setPartialTranscript('');
        client.close();
        wsClientRef.current = null;
        streamRecorderRef.current = null;
        streamingActiveRef.current = false;
        recorderRef.current?.cancel();
        recorderRef.current = null;
        releaseStream();
        setTranscribing(false);
        return text;
      }
    }

    // Batch fallback
    const recorder = recorderRef.current;
    if (!recorder) {
      setTranscribing(false);
      return '';
    }
    streamRecorderRef.current?.cancel();
    wsClientRef.current?.close();
    streamingActiveRef.current = false;

    setTranscribing(true);

    try {
      const blob = await recorder.stop();
      const fd = blobToFormData(blob);

      const res = await fetch(`${YAPPER_URL}/v1/transcribe`, {
        method: 'POST',
        body: fd,
      });

      if (!res.ok) {
        setError(`Transcription failed (${res.status})`);
        return '';
      }

      const data = await res.json();
      return data.text || '';
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transcription failed');
      return '';
    } finally {
      setTranscribing(false);
      setPartialTranscript('');
      recorderRef.current = null;
      wsClientRef.current?.close();
      wsClientRef.current = null;
      streamRecorderRef.current = null;
      streamingActiveRef.current = false;
      releaseStream();
    }
  }, [releaseStream, setPartialTranscript]);

  const cancelRecording = useCallback(() => {
    captureIdRef.current += 1;
    resolveCaptureDoneRef.current?.();
    finalResolveRef.current?.('');
    // Clean up streaming
    wsClientRef.current?.close();
    wsClientRef.current = null;
    streamRecorderRef.current?.cancel();
    streamRecorderRef.current = null;
    streamingActiveRef.current = false;
    finalResolveRef.current = null;

    // Clean up batch
    recorderRef.current?.cancel();
    recorderRef.current = null;

    releaseStream();
    setRecording(false);
    setTranscribing(false);
    setPartialTranscript('');
  }, [releaseStream, setPartialTranscript]);

  // --- TTS: Voice list ---
  const fetchVoices = useCallback((): Promise<boolean> => {
    if (voicesFetchedRef.current) return Promise.resolve(true);
    if (voicesFetchRef.current) return voicesFetchRef.current;

    const request = (async () => {
      try {
        const res = await fetch(`${YAPPER_URL}/v1/voices`);
        if (!res.ok) return false;
        const data = await res.json();
        if (Array.isArray(data.voices) && data.voices.length > 0) {
          setVoices(data.voices);
          voicesFetchedRef.current = true;

          // If no stored voice, default to first from list
          const stored = localStorage.getItem(TTS_VOICE_KEY);
          if (!stored) {
            setSelectedVoice(data.voices[0].id);
            localStorage.setItem(TTS_VOICE_KEY, data.voices[0].id);
          }
          return true;
        }
      } catch {
        // A retry is scheduled by the caller while TTS remains available.
      }
      return false;
    })();

    voicesFetchRef.current = request;
    void request.finally(() => {
      if (voicesFetchRef.current === request) voicesFetchRef.current = null;
    });
    return request;
  }, []);

  // A picker is always available for explicit read-aloud, so load voices whenever
  // the service advertises TTS support. Playback still only starts from a user tap.
  useEffect(() => {
    if (!ttsAvailable || voicesFetchedRef.current) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const loaded = await fetchVoices();
      if (!loaded && !cancelled) {
        retryTimer = setTimeout(load, TTS_VOICES_RETRY_DELAY_MS);
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [ttsAvailable, fetchVoices]);

  // --- TTS: Voice selection ---
  const setVoice = useCallback((id: string) => {
    setSelectedVoice(id);
    localStorage.setItem(TTS_VOICE_KEY, id);
  }, []);

  // --- TTS: Speak ---
  const speak = useCallback(
    async (text: string) => {
      // iOS requires AudioContext activation during the initiating user gesture.
      // Start the unlock before synthesis yields control back to the browser.
      void unlockAudioContext().catch(() => {});

      // Abort any in-flight synthesis
      abortRef.current?.abort();
      currentPlayRef.current?.stop();

      const controller = new AbortController();
      abortRef.current = controller;

      const chunks = chunkText(text);
      if (chunks.length === 0) return;

      setSpeaking(true);

      try {
        for (const chunk of chunks) {
          if (controller.signal.aborted) break;

          try {
            const blob = await synthesize(chunk, selectedVoice, YAPPER_URL, controller.signal);
            if (controller.signal.aborted) break;

            const handle = playAudio(blob);
            currentPlayRef.current = handle;
            await handle.play();
          } catch (chunkErr: unknown) {
            // Abort: re-throw to halt the loop (check signal as fallback for wrapped errors)
            if (
              controller.signal.aborted ||
              (chunkErr instanceof Error && chunkErr.name === 'AbortError')
            ) {
              throw chunkErr;
            }
            // Other errors (synthesis failure, decode failure): skip chunk, continue
            console.warn(
              'TTS chunk skipped:',
              chunkErr instanceof Error ? chunkErr.message : 'unknown',
            );
          }
        }
      } catch (err: unknown) {
        // AbortError / signal abort is expected on interrupt — suppress it
        if (!controller.signal.aborted && err instanceof Error && err.name !== 'AbortError') {
          console.warn('TTS error:', err.message);
        }
      } finally {
        if (abortRef.current === controller) {
          setSpeaking(false);
          currentPlayRef.current = null;
        }
      }
    },
    [selectedVoice],
  );

  // --- TTS: Stop ---
  const stopSpeaking = useCallback(() => {
    abortRef.current?.abort();
    currentPlayRef.current?.stop();
    currentPlayRef.current = null;
    setSpeaking(false);
  }, []);

  return {
    // STT
    available,
    recording,
    transcribing,
    partialTranscript,
    micBlocked,
    error,
    startRecording,
    stopRecording,
    cancelRecording,

    // TTS
    ttsAvailable,
    speaking,
    voices,
    selectedVoice,
    speak,
    stopSpeaking,
    setVoice,
  };
}
