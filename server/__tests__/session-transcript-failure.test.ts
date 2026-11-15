import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import type { StoredEvent } from '@mitzo/protocol';
import { replayEventsToTranscript } from '../conversation-transcript.js';
import { createSessionMessagesHandler } from '../session-messages-route.js';
import { observeTranscriptSync } from '../transcript-observation.js';
import { TranscriptReadFailure } from '../transcript-read-failure.js';

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => log }));

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
    expect(events).toHaveLength(2);
  },
);
