import type { RequestHandler } from 'express';

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
    if (previous) return previous;
    const result = Promise.resolve()
      .then(work)
      .finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  };
  return async (req, res) => {
    try {
      const sessionId = req.params.id as string;
      const revision = read.getRevision?.(sessionId);
      const transcript = req.query.transcript;
      if (
        transcript === 'durable' ||
        (Array.isArray(transcript) && transcript.includes('durable'))
      ) {
        if (transcript !== 'durable' || Object.keys(req.query).length !== 1) {
          res.status(400).json({ error: 'Invalid durable transcript query' });
          return;
        }
        if (!read.getDurableSessionTranscript) throw new Error('Durable source unavailable');
        res.json(
          await coalesce(JSON.stringify([sessionId, revision, 'durable']), () =>
            read.getDurableSessionTranscript!(sessionId),
          ),
        );
        return;
      }
      if (req.query.transcript === '1') {
        res.json(
          await coalesce(JSON.stringify([sessionId, revision, 'transcript']), () =>
            read.getSessionTranscript(sessionId),
          ),
        );
        return;
      }
      const rawCursor = req.query.throughSeq;
      if (rawCursor !== undefined) {
        if (typeof rawCursor !== 'string' || !/^(0|[1-9]\d*)$/.test(rawCursor)) {
          res.status(400).json({ error: 'Invalid reconnect cursor' });
          return;
        }
        const cursor = Number(rawCursor);
        if (!Number.isSafeInteger(cursor)) {
          res.status(400).json({ error: 'Invalid reconnect cursor' });
          return;
        }
        res.json(
          await coalesce(JSON.stringify([sessionId, revision, 'reconnect', cursor]), () =>
            read.getReconnectTranscript(sessionId, cursor),
          ),
        );
        return;
      }
      res.json(
        await coalesce(JSON.stringify([sessionId, revision, 'messages']), () =>
          read.getMessages(sessionId),
        ),
      );
    } catch {
      // Never return partial history, retry another source, or expose stored content.
      res.status(500).json({ error: 'Session transcript unavailable' });
    }
  };
}
