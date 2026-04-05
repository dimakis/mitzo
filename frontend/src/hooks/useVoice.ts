// Voice integration hook — Yapper health, mic capture, batch transcription.

import { useState, useEffect, useRef, useCallback } from 'react';
import { YAPPER_URL, YAPPER_HEALTH_POLL_MS } from '../lib/constants';
import { negotiateMimeType, createRecorder, blobToFormData, type Recorder } from '../lib/audio';

interface YapperHealth {
  status: string;
  models: { stt: boolean; tts: boolean };
}

export interface UseVoiceReturn {
  available: boolean;
  recording: boolean;
  transcribing: boolean;
  micBlocked: boolean;
  error: string | null;

  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string>;
  cancelRecording: () => void;
}

export function useVoice(): UseVoiceReturn {
  const [available, setAvailable] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micBlocked, setMicBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<Recorder | null>(null);
  const mimeTypeRef = useRef<string | undefined>(undefined);

  // --- Health polling ---
  useEffect(() => {
    let mounted = true;
    async function checkHealth() {
      try {
        const res = await fetch(`${YAPPER_URL}/health`);
        if (!res.ok) {
          if (mounted) setAvailable(false);
          return;
        }
        const data: YapperHealth = await res.json();
        if (mounted) setAvailable(data.status === 'ready' && data.models.stt === true);
      } catch {
        if (mounted) setAvailable(false);
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

  // --- Recording ---
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

  return {
    available,
    recording,
    transcribing,
    micBlocked,
    error,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
