// MediaRecorder wrapper for voice capture.
// Negotiates format at runtime (WebM/Opus preferred, MP4 fallback for Safari).

import { MAX_RECORDING_DURATION_MS } from './constants';

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const;

/** Pick the best supported audio mimeType, or undefined if none. */
export function negotiateMimeType(): string | undefined {
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return undefined;
}

export interface Recorder {
  start: () => void;
  stop: () => Promise<Blob>;
  cancel: () => void;
  onAutoStop: (() => void) | null;
}

/** Create a Recorder that wraps MediaRecorder with auto-stop and cancel. */
export function createRecorder(stream: MediaStream, mimeType: string): Recorder {
  const mr = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  let autoStopTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let resolveBlob: ((blob: Blob) => void) | undefined;

  const recorder: Recorder = {
    onAutoStop: null,

    start() {
      cancelled = false;
      chunks.length = 0;

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mr.onstop = () => {
        clearTimeout(autoStopTimer);
        if (!cancelled && resolveBlob) {
          resolveBlob(new Blob(chunks, { type: mimeType }));
        }
      };

      mr.start();

      autoStopTimer = setTimeout(() => {
        if (mr.state === 'recording') {
          recorder.onAutoStop?.();
          mr.stop();
          stopTracks(stream);
        }
      }, MAX_RECORDING_DURATION_MS);
    },

    stop() {
      return new Promise<Blob>((resolve) => {
        resolveBlob = resolve;
        if (mr.state === 'recording') {
          mr.stop();
        }
        clearTimeout(autoStopTimer);
        stopTracks(stream);
      });
    },

    cancel() {
      cancelled = true;
      clearTimeout(autoStopTimer);
      if (mr.state === 'recording') {
        mr.stop();
      }
      stopTracks(stream);
    },
  };

  return recorder;
}

export interface StreamingRecorder {
  start: () => void;
  stop: () => void;
  cancel: () => void;
  onChunk: ((data: Blob) => void) | null;
  onStop: (() => void) | null;
  onAutoStop: (() => void) | null;
}

const DEFAULT_TIMESLICE_MS = 250;

/** Create a streaming recorder that emits chunks during recording via timeslice. */
export function createStreamingRecorder(
  stream: MediaStream,
  mimeType: string,
  timesliceMs = DEFAULT_TIMESLICE_MS,
): StreamingRecorder {
  const mr = new MediaRecorder(stream, { mimeType });
  let autoStopTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const recorder: StreamingRecorder = {
    onChunk: null,
    onStop: null,
    onAutoStop: null,

    start() {
      cancelled = false;

      mr.ondataavailable = (e) => {
        if (e.data.size > 0 && !cancelled) {
          recorder.onChunk?.(e.data);
        }
      };

      mr.onstop = () => {
        clearTimeout(autoStopTimer);
        if (!cancelled) {
          recorder.onStop?.();
        }
      };

      mr.start(timesliceMs);

      autoStopTimer = setTimeout(() => {
        if (mr.state === 'recording') {
          recorder.onAutoStop?.();
          mr.stop();
          stopTracks(stream);
        }
      }, MAX_RECORDING_DURATION_MS);
    },

    stop() {
      clearTimeout(autoStopTimer);
      if (mr.state === 'recording') {
        mr.stop();
      }
      stopTracks(stream);
    },

    cancel() {
      cancelled = true;
      clearTimeout(autoStopTimer);
      if (mr.state === 'recording') {
        mr.stop();
      }
      stopTracks(stream);
    },
  };

  return recorder;
}

function stopTracks(stream: MediaStream) {
  stream.getTracks().forEach((t) => t.stop());
}

function extensionForMime(mime: string): string {
  if (mime.includes('mp4')) return 'mp4';
  return 'webm';
}

/** Wrap a recorded blob in FormData for POST /v1/transcribe. */
export function blobToFormData(blob: Blob): FormData {
  const ext = extensionForMime(blob.type);
  const fd = new FormData();
  fd.append('file', new File([blob], `recording.${ext}`, { type: blob.type }));
  return fd;
}
