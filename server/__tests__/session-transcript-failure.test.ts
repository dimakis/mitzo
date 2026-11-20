import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import type { StoredEvent } from '@mitzo/protocol';
import { replayEventsToTranscript } from '../conversation-transcript.js';
import { createSessionMessagesHandler } from '../session-messages-route.js';
import { observeTranscriptSync } from '../transcript-observation.js';
import { TranscriptReadFailure } from '../transcript-read-failure.js';
import { retainedRuntimeFailure } from '../runtime-failure-diagnostics.js';

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => log }));
afterEach(() => log.warn.mockReset());

function failingHistory(cause: unknown) {
  const replay = () =>
    observeTranscriptSync('projection', () => {
      throw cause;
    });
  const app = express();
  app.get(
    '/sessions/:id/messages',
    createSessionMessagesHandler({
      getMessages: async () => replay(),
      getSessionTranscript: async () => replay(),
      getReconnectTranscript: replay,
      getDurableSessionTranscript: replay,
    }),
  );
  return app;
}

it.each(['', '?transcript=1', '?throughSeq=2', '?transcript=durable'])(
  'retains the actual handler cause under its returned reference %s even if logging fails',
  async (query) => {
    const cause = Error('PRIVATE history /private/account');
    const diagnosticCause = Error('PRIVATE logger payload');
    log.warn.mockImplementation(() => {
      throw diagnosticCause;
    });
    const result = await request(failingHistory(cause))
      .get('/sessions/original/messages' + query)
      .timeout(2000)
      .expect(500);
    const id = result.headers['x-mitzo-diagnostic-id'];
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(retainedRuntimeFailure(id)).toEqual({ cause, diagnosticCause });
    expect(retainedRuntimeFailure(id)?.cause).toBe(cause);
    expect(result.body).toEqual({ error: 'Session transcript unavailable' });
    expect(JSON.stringify([result.body, result.headers, log.warn.mock.calls])).not.toMatch(
      /PRIVATE|private\/account|logger payload/,
    );
  },
);

it('retains non-Error history failures internally without serializing them', async () => {
  const cause = { private: 'PRIVATE upstream content' };
  const result = await request(failingHistory(cause))
    .get('/sessions/original/messages')
    .expect(500);
  const retained = retainedRuntimeFailure(result.headers['x-mitzo-diagnostic-id']);
  expect(retained?.cause).toBeInstanceOf(Error);
  expect((retained?.cause as Error).cause).toBe(cause);
  expect(JSON.stringify([result.body, log.warn.mock.calls])).not.toContain('PRIVATE');
});

it('evicts old handler causes from the shared bounded host buffer', async () => {
  const cause = Error('PRIVATE retained cause');
  const app = failingHistory(cause);
  const ids: string[] = [];
  for (let index = 0; index < 33; index++) {
    const result = await request(app).get('/sessions/original/messages').expect(500);
    ids.push(result.headers['x-mitzo-diagnostic-id']);
  }
  expect(new Set(ids).size).toBe(33);
  expect(retainedRuntimeFailure(ids[0]!)).toBeUndefined();
  for (const id of ids.slice(1)) expect(retainedRuntimeFailure(id)?.cause).toBe(cause);
});

it('retains the original replay failure without disclosing its content in diagnostics', () => {
  const cause = Error('PRIVATE upstream body /private/account');
  const failure = new TranscriptReadFailure(cause, 'transcript');
  expect(failure.cause).toBe(cause);
  expect(failure.telemetry()).toMatchObject({
    code: 'session_transcript_unavailable',
    reason: 'history_read_failed',
    variant: 'transcript',
  });
  expect(JSON.stringify(failure.telemetry())).not.toMatch(/PRIVATE|upstream|private\/account/);
});

it.each([
  ['', 'messages'],
  ['?transcript=1', 'transcript'],
  ['?throughSeq=2', 'reconnect'],
] as const)(
  'reports an actual replay rejection through HTTP %s with stage and safe reason',
  async (query, variant) => {
    log.warn.mockClear();
    const events: StoredEvent[] = [
      {
        seq: 1,
        sessionId: 'original',
        createdAt: 1,
        type: 'message_start',
        payload: { messageId: 'reply' },
      },
      {
        seq: 2,
        sessionId: 'original',
        createdAt: 2,
        type: 'block_end',
        payload: {
          messageId: 'recorded-owner',
          blockId: 'b0',
          blockType: 'tool_use',
          toolName: 'Bash',
          toolId: 'private-tool',
        },
      },
      {
        seq: 3,
        sessionId: 'original',
        createdAt: 3,
        type: 'tool_result',
        payload: {
          messageId: 'missing-owner',
          toolId: 'private-tool',
          result: 'PRIVATE tool result',
        },
      },
    ];
    const replay = () =>
      observeTranscriptSync('projection', () => replayEventsToTranscript(events));
    const app = express();
    app.get(
      '/sessions/:id/messages',
      createSessionMessagesHandler({
        getMessages: async () => replay(),
        getSessionTranscript: async () => replay(),
        getReconnectTranscript: replay,
      }),
    );
    const result = await request(app)
      .get('/sessions/original/messages' + query)
      .expect(500);
    expect(result.body).toEqual({ error: 'Session transcript unavailable' });
    expect(result.headers['x-mitzo-diagnostic-id']).toEqual(expect.any(String));
    expect(retainedRuntimeFailure(result.headers['x-mitzo-diagnostic-id'])?.cause).toEqual(
      expect.objectContaining({ message: 'Unmatched attributed tool result in stored transcript' }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      'Session transcript unavailable',
      expect.objectContaining({
        sessionId: 'original',
        code: 'session_transcript_unavailable',
        reason: 'tool_result_unmatched',
        stage: 'transcript.projection',
        variant,
        diagnosticId: result.headers['x-mitzo-diagnostic-id'],
      }),
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/PRIVATE|private-tool|missing-owner/);
    expect(events).toHaveLength(3);
  },
);
