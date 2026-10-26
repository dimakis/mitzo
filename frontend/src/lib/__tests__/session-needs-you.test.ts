import { describe, expect, it } from 'vitest';
import type { SessionActivity } from '@mitzo/protocol';
import { sessionNeedsYouReason } from '../session-attention';

const activity: SessionActivity = {
  sessionId: 'chat',
  clientId: 'client',
  title: 'Fix login',
  state: 'waiting',
  flags: [],
  lastEventAt: 1,
};

describe('Needs you', () => {
  it.each(['permission', 'review'] as const)('includes a confirmed %s request', (waitReason) => {
    expect(sessionNeedsYouReason({ ...activity, waitReason })).toBe(waitReason);
  });
  it.each([
    { state: 'done', awaitingReply: true },
    { state: 'idle', awaitingReply: true },
    { state: 'done', uncommittedWork: true },
    { state: 'waiting', waitReason: 'blocked' },
    { state: 'waiting' },
    { state: 'working', waitReason: 'permission' },
    { state: 'paused', waitReason: 'review' },
  ] satisfies Partial<SessionActivity>[])('excludes %j', (overrides) => {
    expect(sessionNeedsYouReason({ ...activity, ...overrides })).toBeNull();
  });
  it('clears when the request is answered even if the assistant spoke last', () => {
    expect(sessionNeedsYouReason({ ...activity, waitReason: 'permission' })).toBe('permission');
    expect(sessionNeedsYouReason({ ...activity, state: 'done', awaitingReply: true })).toBeNull();
  });
});
