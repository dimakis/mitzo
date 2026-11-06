import type { Response } from 'express';
import { beginTranscriptObservation } from './transcript-observation.js';

type Observation = ReturnType<typeof beginTranscriptObservation>;

/** Observe Express's existing serializer once; do not stringify or copy history for telemetry. */
export function sendTranscriptResponse(res: Response, value: unknown, request: Observation): void {
  if (res.destroyed) {
    request.end(true);
    return;
  }
  const serialization = request.run(() => beginTranscriptObservation('serialize'));
  let writing: Observation | undefined;
  const originalSend = res.send;
  const canObserveWrite = typeof originalSend === 'function' && typeof res.once === 'function';
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const failed = res.statusCode >= 500 || !res.writableFinished;
    const length = res.getHeader('content-length');
    const bytes =
      typeof length === 'number' ? length : typeof length === 'string' ? Number(length) : NaN;
    const encoding = res.getHeader('content-encoding');
    writing?.annotate({
      ...(Number.isSafeInteger(bytes) && bytes >= 0 ? { 'transcript.response_bytes': bytes } : {}),
      'transcript.response_encoding':
        encoding === undefined
          ? 'identity'
          : ['gzip', 'br', 'deflate'].includes(String(encoding))
            ? String(encoding)
            : 'other',
      'transcript.response_aborted': !res.writableFinished,
    });
    writing?.end(failed);
    request.end(failed);
  };
  if (canObserveWrite) {
    res.once('finish', finish);
    res.once('close', finish);
    res.send = function (body) {
      res.send = originalSend;
      serialization.end();
      writing = request.run(() => beginTranscriptObservation('response_write'));
      return originalSend.call(this, body);
    };
  }
  try {
    res.json(value);
    serialization.end();
    if (!canObserveWrite) request.end();
  } catch (error) {
    serialization.end(true);
    writing?.end(true);
    request.end(true);
    throw error;
  } finally {
    if (canObserveWrite) res.send = originalSend;
  }
}
