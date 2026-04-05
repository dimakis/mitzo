// Voice integration hook — Yapper health, mic capture, batch transcription, TTS playback.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  YAPPER_URL,
  YAPPER_HEALTH_POLL_MS,
  TTS_ENABLED_KEY,
  TTS_VOICE_KEY,
  DEFAULT_TTS_VOICE,
} from '../lib/constants';
import { negotiateMimeType, createRecorder, blobToFormData, type Recorder } from '../lib/audio';
import {
  chunkText,
  synthesize,
  playAudio,
  getOrCreateAudioContext,
  closeAudioContext,
} from '../lib/tts';

interface YapperHealth {
  status: string;
  models: { stt: boolean; tts: boolean };
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

  const recorderRef = useRef<Recorder | null>(null);
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
          setAvailable(data.status === 'ready' && data.models.stt === true);
          setTtsAvailable(data.status === 'ready' && data.models.tts === true);
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

  // --- STT: Recording ---
  const startRecording = useCallback(async () => {
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = mimeTypeRef.current;
      if (!mimeType) {
        setError('No supported audio format');
        return;
      }

      const recorder = createRecorder(stream, mimeType);
      recorder.onAutoStop = () => {
        setRecording(false);
      };
      recorderRef.current = recorder;
      recorder.start();
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
    const recorder = recorderRef.current;
    if (!recorder) return '';

    setRecording(false);
    setTranscribing(true);
    setError(null);

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
      recorderRef.current = null;
    }
  }, []);

  const cancelRecording = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setRecording(false);
    setTranscribing(false);
  }, []);

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
        // Lazy AudioContext creation on user gesture
        getOrCreateAudioContext();
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

          const blob = await synthesize(chunk, selectedVoice, YAPPER_URL, controller.signal);
          if (controller.signal.aborted) break;

          const handle = playAudio(blob);
          currentPlayRef.current = handle;
          await handle.play();
        }
      } catch (err: unknown) {
        // AbortError is expected on interrupt
        if (err instanceof Error && err.name !== 'AbortError') {
          // Log but don't surface — TTS errors are non-critical
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
