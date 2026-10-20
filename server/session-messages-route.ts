import type { RequestHandler } from 'express';

/** Replay can reject corrupt or unverifiable history. Express 4 does not catch
 * rejected async handlers, so contain all transcript variants at this boundary. */
export function createSessionMessagesHandler(read: {
  getMessages(sessionId: string): Promise<unknown>;
  getSessionTranscript(sessionId: string): Promise<unknown>;
  getReconnectTranscript(sessionId: string, throughSeq: number): unknown;
  getDurableSessionTranscript?(sessionId: string): unknown;
}): RequestHandler {
  return async (req, res) => {
    try {
      const sessionId = req.params.id as string;
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
        res.json(await read.getDurableSessionTranscript(sessionId));
        return;
      }
      if (req.query.transcript === '1') {
        res.json(await read.getSessionTranscript(sessionId));
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
        res.json(await read.getReconnectTranscript(sessionId, cursor));
        return;
      }
      res.json(await read.getMessages(sessionId));
    } catch {
      // Never return partial history, retry another source, or expose stored content.
      res.status(500).json({ error: 'Session transcript unavailable' });
    }
  };
}
