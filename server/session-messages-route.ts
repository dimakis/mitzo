import type { RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { beginTranscriptObservation, observeTranscriptAsync } from './transcript-observation.js';
import { sendTranscriptResponse } from './transcript-response.js';
import { TranscriptReadFailure } from './transcript-read-failure.js';
import { createLogger } from './logger.js';
import { retainRuntimeFailure } from './runtime-failure-diagnostics.js';
import { collaborationSourceDiagnostic } from './collaboration-source-diagnostic.js';

const log = createLogger('session-transcript');

/** Replay can reject corrupt or unverifiable history. Express 4 does not catch
 * rejected async handlers, so contain all transcript variants at this boundary. */
export function createSessionMessagesHandler(read: {
  getMessages(sessionId: string): Promise<unknown>;
  getSessionTranscript(sessionId: string): Promise<unknown>;
  getReconnectTranscript(sessionId: string, throughSeq: number): unknown;
  getDurableSessionTranscript?(sessionId: string): unknown;
  getRevision?(sessionId: string): number;
}): RequestHandler {
  const pending = new Map<string, Promise<unknown>>();
  const coalesce = (key: string, work: () => unknown) => {
    const previous = pending.get(key);
    if (previous) return { result: previous, joined: true };
    const result = Promise.resolve()
      .then(() => observeTranscriptAsync('read', async () => work()))
      .finally(() => pending.delete(key));
    pending.set(key, result);
    return { result, joined: false };
  };
  return async (req, res) => {
    let variant = 'request';
    const observation = beginTranscriptObservation('request', {
      'transcript.session_fingerprint': createHash('sha256')
        .update(req.params.id as string)
        .digest('hex')
        .slice(0, 16),
    });
    res.once?.('close', () => observation.end(!res.writableFinished));
    await observation.run(async () => {
      try {
        const sessionId = req.params.id as string;
        const revision = read.getRevision?.(sessionId);
        const transcript = req.query.transcript;
        const respond = async (selectedVariant: string, work: () => unknown, cursor?: number) => {
          variant = selectedVariant;
          observation.annotate({
            'transcript.variant': variant,
            ...(cursor === undefined ? {} : { 'transcript.reconnect_cursor': cursor }),
          });
          const shared = coalesce(JSON.stringify([sessionId, revision, variant, cursor]), work);
          observation.annotate({ 'transcript.coalesced': shared.joined });
          const value = await shared.result;
          const messages = Array.isArray(value)
            ? value
            : value &&
                typeof value === 'object' &&
                'messages' in value &&
                Array.isArray(value.messages)
              ? value.messages
              : undefined;
          if (messages) observation.annotate({ 'transcript.messages_count': messages.length });
          sendTranscriptResponse(res, value, observation);
        };
        if (
          transcript === 'durable' ||
          (Array.isArray(transcript) && transcript.includes('durable'))
        ) {
          if (transcript !== 'durable' || Object.keys(req.query).length !== 1) {
            res.status(400).json({ error: 'Invalid durable transcript query' });
            observation.end();
            return;
          }
          if (!read.getDurableSessionTranscript) throw new Error('Durable source unavailable');
          await respond('durable', () => read.getDurableSessionTranscript!(sessionId));
          return;
        }
        if (req.query.transcript === '1') {
          await respond('transcript', () => read.getSessionTranscript(sessionId));
          return;
        }
        const rawCursor = req.query.throughSeq;
        if (rawCursor !== undefined) {
          if (typeof rawCursor !== 'string' || !/^(0|[1-9]\d*)$/.test(rawCursor)) {
            res.status(400).json({ error: 'Invalid reconnect cursor' });
            observation.end();
            return;
          }
          const cursor = Number(rawCursor);
          if (!Number.isSafeInteger(cursor)) {
            res.status(400).json({ error: 'Invalid reconnect cursor' });
            observation.end();
            return;
          }
          await respond('reconnect', () => read.getReconnectTranscript(sessionId, cursor), cursor);
          return;
        }
        await respond('messages', () => read.getMessages(sessionId));
      } catch (cause) {
        const failure = new TranscriptReadFailure(cause, variant);
        retainRuntimeFailure(failure.diagnosticId, cause, () => {
          log.warn('Session transcript unavailable', {
            sessionId: req.params.id,
            ...failure.telemetry(),
          });
        });
        res.setHeader?.('X-Mitzo-Diagnostic-Id', failure.diagnosticId);
        observation.end(true);
        const source = variant === 'durable' ? collaborationSourceDiagnostic(cause) : undefined;
        if (source) {
          res.status(422).json({ error: source.message, code: source.code });
          return;
        }
        // Never return partial history, retry another source, or expose stored content.
        res.status(500).json({ error: 'Session transcript unavailable' });
      }
    });
  };
}
