// Voice integration hook — Yapper health, mic capture, streaming + batch transcription, TTS playback.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  YAPPER_URL,
  YAPPER_HEALTH_POLL_MS,
  TTS_ENABLED_KEY,
  TTS_VOICE_KEY,
  DEFAULT_TTS_VOICE,
} from '../lib/constants';
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

interface YapperHealth {
  status: string;
  models?: { stt?: boolean; tts?: boolean };
}

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
  ttsEnabled: boolean;
  speaking: boolean;
  voices: Voice[];
  selectedVoice: string;

  // TTS actions
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  setTtsEnabled: (v: boolean) => void;
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
  // --- STT state ---
  const [available, setAvailable] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micBlocked, setMicBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- TTS state ---
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const [ttsEnabled, setTtsEnabledState] = useState(
    () => localStorage.getItem(TTS_ENABLED_KEY) === 'true',
  );
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
  const finalResolveRef = useRef<((text: string) => void) | null>(null);
  const streamingActiveRef = useRef(false);
  const mimeTypeRef = useRef<string | undefined>(undefined);
  const voicesFetchedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const currentPlayRef = useRef<{ stop: () => void } | null>(null);

  // --- Health polling ---
  useEffect(() => {
    let mounted = true;
    async function checkHealth() {
      try {
        const res = await fetch(`${YAPPER_URL}/health`);
        if (!res.ok) {
          if (mounted) {
            setAvailable(false);
            setTtsAvailable(false);
          }
          return;
        }
        const data: YapperHealth = await res.json();
        if (mounted) {
          const isReady = data.status === 'ready' || data.status === 'ok';
          // Yapper may omit `models` — when status is ok, assume both capabilities
          const stt = data.models ? data.models.stt === true : isReady;
          const tts = data.models ? data.models.tts === true : isReady;
          setAvailable(isReady && stt);
          setTtsAvailable(isReady && tts);
        }
      } catch {
        if (mounted) {
          setAvailable(false);
          setTtsAvailable(false);
        }
      }
    }

    checkHealth();
    const timer = setInterval(checkHealth, YAPPER_HEALTH_POLL_MS);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

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
    setError(null);
    setPartialTranscript('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = mimeTypeRef.current;
      if (!mimeType) {
        setError('No supported audio format');
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
        if (event.type === 'partial') {
          setPartialTranscript(event.text);
        } else if (event.type === 'final') {
          // Resolve the pending stopRecording promise
          finalResolveRef.current?.(event.text);
          finalResolveRef.current = null;
        }
      };

      wsClient.onError = () => {
        // Mark streaming as failed — stopRecording will use batch fallback
        streamingActiveRef.current = false;
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

      // Wire chunks to WS
      streamRec.onChunk = (blob: Blob) => {
        blob.arrayBuffer().then((buf) => {
          if (streamingActiveRef.current) {
            wsClient.sendAudio(buf);
          }
        });
      };

      streamRec.onAutoStop = () => setRecording(false);

      streamRec.start();
      batchRec.start();
      setRecording(true);
      setMicBlocked(false);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setMicBlocked(true);
      } else {
        setError(err instanceof Error ? err.message : 'Mic access failed');
      }
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<string> => {
    setRecording(false);
    setError(null);

    // Streaming path: send END and wait for final transcript
    if (streamingActiveRef.current && wsClientRef.current) {
      streamRecorderRef.current?.stop();
      wsClientRef.current.sendEnd();

      try {
        const text = await new Promise<string>((resolve) => {
          finalResolveRef.current = resolve;
          // Timeout: use best-effort partial transcript if no final arrives in 5s
          setTimeout(() => {
            if (finalResolveRef.current === resolve) {
              finalResolveRef.current = null;
              resolve(partialRef.current);
            }
          }, 5000);
        });

        setPartialTranscript('');
        wsClientRef.current?.close();
        wsClientRef.current = null;
        streamRecorderRef.current = null;
        streamingActiveRef.current = false;

        // Also stop the batch recorder (discard its data)
        recorderRef.current?.cancel();
        recorderRef.current = null;

        releaseStream();
        return text;
      } catch {
        // Fall through to batch
      }
    }

    // Batch fallback
    const recorder = recorderRef.current;
    if (!recorder) return '';

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
  }, [releaseStream]);

  const cancelRecording = useCallback(() => {
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
  }, [releaseStream]);

  // --- TTS: Voice list ---
  const fetchVoices = useCallback(async () => {
    if (voicesFetchedRef.current) return;
    try {
      const res = await fetch(`${YAPPER_URL}/v1/voices`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.voices)) {
        setVoices(data.voices);
        voicesFetchedRef.current = true;

        // If no stored voice, default to first from list
        const stored = localStorage.getItem(TTS_VOICE_KEY);
        if (!stored && data.voices.length > 0) {
          setSelectedVoice(data.voices[0].id);
          localStorage.setItem(TTS_VOICE_KEY, data.voices[0].id);
        }
      }
    } catch {
      // Voice list fetch failed — use default
    }
  }, []);

  // --- TTS: Toggle ---
  const setTtsEnabled = useCallback(
    (v: boolean) => {
      setTtsEnabledState(v);
      localStorage.setItem(TTS_ENABLED_KEY, String(v));
      if (v) {
        // Unlock AudioContext on user gesture — plays a silent buffer so iOS
        // Safari allows programmatic playback later when assistant messages arrive.
        unlockAudioContext().catch(() => {});
        // Lazy voice list fetch
        fetchVoices();
      }
    },
    [fetchVoices],
  );

  // --- TTS: Voice selection ---
  const setVoice = useCallback((id: string) => {
    setSelectedVoice(id);
    localStorage.setItem(TTS_VOICE_KEY, id);
  }, []);

  // --- TTS: Speak ---
  const speak = useCallback(
    async (text: string) => {
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
    ttsEnabled,
    speaking,
    voices,
    selectedVoice,
    speak,
    stopSpeaking,
    setTtsEnabled,
    setVoice,
  };
}
