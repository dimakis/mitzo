import { afterEach, expect, it, vi } from 'vitest';
import { SessionActivityEvents } from '../session-activity-events.js';
afterEach(() => vi.useRealTimers());

it('separates elapsed, visible messages, completion and tool activity without retaining content', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const events = new SessionActivityEvents();
  events.start('one');
  vi.setSystemTime(2000);
  events.observe('one', {
    type: 'block_start',
    blockType: 'tool_use',
    toolName: 'Read',
    rawInput: { path: 'private' },
  });
  expect(events.get('one')).toMatchObject({
    turnStartedAt: 1000,
    lastEventAt: 2000,
    phase: 'reading',
  });
  expect(events.get('one').lastMessageAt).toBeUndefined();
  events.observe('one', { type: 'block_start', blockType: 'text', messageId: 'm' });
  vi.setSystemTime(3000);
  events.observe('one', { type: 'message_end', messageId: 'm' });
  expect(events.get('one').lastMessageAt).toBe(3000);
  vi.setSystemTime(4000);
  events.finish('one');
  expect(events.get('one')).toMatchObject({
    turnStartedAt: 1000,
    lastMessageAt: 3000,
    completedAt: 4000,
  });
  expect(JSON.stringify(events.get('one'))).not.toContain('private');
});

it('does not treat token deltas or tool-only message ends as a new visible message', () => {
  const events = new SessionActivityEvents();
  events.start('one');
  expect(events.observe('one', { type: 'block_delta', delta: 'private' })).toBe(false);
  events.observe('one', {
    type: 'block_start',
    blockType: 'tool_use',
    toolName: 'Bash',
    messageId: 'm',
  });
  events.observe('one', { type: 'message_end', messageId: 'm' });
  expect(events.get('one').lastMessageAt).toBeUndefined();
  expect(events.get('one').phase).toBe('command');
  events.forget('one');
  expect(events.get('one')).toEqual({});
});
