import { expect, it } from 'vitest';
import { CollaborationApiError } from '@mitzo/client';
import { conversationJoiningFailure } from '../conversation-joining-failure';

it.each(['execution_unavailable', 'capacity_refused', 'snapshot_changed'])(
  'preserves the safe %s refusal without exposing its private exception text',
  (code) => {
    const failure = conversationJoiningFailure(
      new CollaborationApiError(422, code, 'PRIVATE provider payload and credential path'),
      'review',
      'original-request',
    );
    expect(failure.diagnostic).toEqual({
      code,
      stage: 'review',
      requestId: 'original-request',
      status: 422,
    });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE');
  },
);

it('does not expose arbitrary server codes or network exception payloads', () => {
  for (const cause of [
    new CollaborationApiError(503, 'PRIVATE arbitrary code', 'PRIVATE message'),
    new Error('PRIVATE message'),
  ]) {
    const failure = conversationJoiningFailure(cause, 'review', 'original-request');
    expect(failure.diagnostic.code).toBe('joining_review_failed');
    expect(JSON.stringify(failure)).not.toContain('PRIVATE');
  }
});

it('explains expired authorization without discarding the original request reference', () => {
  const failure = conversationJoiningFailure(
    new CollaborationApiError(403, 'unavailable', 'PRIVATE response'),
    'review',
    'original-request',
  );
  expect(failure.message).toMatch(/Sign in again/);
  expect(failure.diagnostic.requestId).toBe('original-request');
  expect(failure.diagnostic.status).toBe(403);
});
