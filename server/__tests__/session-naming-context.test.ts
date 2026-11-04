import { expect, it, vi } from 'vitest';
import type { StoredEvent } from '@mitzo/protocol';
import { sessionNamingPrompts, sessionDisplayName } from '../session-naming-context.js';

function conversation(prompt: string, reply: string): StoredEvent[] {
  return [
    { type: 'user_message', payload: { text: prompt } },
    { type: 'message_start', payload: { messageId: 'reply' } },
    { type: 'block_start', payload: { messageId: 'reply', blockId: 'text', blockType: 'text' } },
    { type: 'block_delta', payload: { messageId: 'reply', blockId: 'text', delta: reply } },
    { type: 'block_end', payload: { messageId: 'reply', blockId: 'text', blockType: 'text' } },
    { type: 'message_end', payload: { messageId: 'reply' } },
  ].map((event, seq) => ({ ...event, sessionId: 'chat-12345678', seq, createdAt: seq }));
}

it('recovers the specific PR subject behind a merge follow-up', () => {
  const events = conversation(
    'Merge it',
    'Merged [Fix mobile chat recovery](https://github.com/dimakis/mitzo/pull/1210).',
  );
  expect(sessionNamingPrompts(events)).toEqual(['mitzo #1210: Fix mobile chat recovery']);
  expect(sessionDisplayName({ sessionId: 'chat-12345678', summary: 'Merge it' }, events)).toBe(
    'Mitzo #1210: Fix mobile chat recovery',
  );
});

it('prefers the actual user task over assistant commentary and later follow-ups', () => {
  const events = conversation('Fix calendar sync', '## Add task reminders\nOther work.');
  expect(sessionNamingPrompts(events)).toEqual(['Fix calendar sync']);
});

it('uses a substantive assistant action when the conversation starts with Continue', () => {
  const events = conversation(
    'Continue',
    'I’ll repair mobile chat recovery and verify the queued messages.',
  );
  expect(sessionDisplayName({ sessionId: 'chat-12345678', summary: 'Continue' }, events)).toBe(
    'Repair mobile chat recovery and verify the queued messages',
  );
});

it('preserves explicit titles, including manual generic titles and manual clears', () => {
  const events = conversation('Merge it', '## Fix mobile chat recovery');
  for (const summary of ['My release checklist', 'Merge it', '']) {
    expect(sessionDisplayName({ sessionId: 's', summary, manuallyRenamed: true }, events)).toBe(
      summary,
    );
  }
  expect(sessionDisplayName({ sessionId: 's', summary: 'Calendar sync repair' }, events)).toBe(
    'Calendar sync repair',
  );
});

it('distinguishes chats with no topic without inventing one', () => {
  const events = conversation('Yo', 'Hello! How can I help?');
  expect(sessionDisplayName({ sessionId: 'chat-12345678', summary: 'Yo' }, events)).toBe(
    'Chat 12345678',
  );
});

it('excludes tool results, thinking, other seats and closeout content', () => {
  const events = conversation('Continue', '## Private deployment plan');
  events[2].payload.blockType = 'thinking';
  events[4].payload.blockType = 'thinking';
  events.push({
    seq: 6,
    sessionId: 's',
    type: 'tool_result',
    payload: { text: 'Fix wrong task' },
    createdAt: 6,
  });
  events.push(
    ...conversation('Fix another seat task', '## Wrong topic').map((e) => ({
      ...e,
      seatId: 'other',
    })),
  );
  events.push({
    seq: 20,
    sessionId: 's',
    type: 'user_message',
    payload: { text: 'Commit the closeout', source: 'closeout' },
    createdAt: 20,
  });
  expect(sessionNamingPrompts(events)).toEqual([]);
});

it('recovers the initial task when retained events have no user message', () => {
  expect(
    sessionDisplayName({ sessionId: 's', initialPrompt: 'Fix calendar sync', summary: '' }, []),
  ).toBe('Fix calendar sync');
});

it('does not load history for a useful title or initial request', () => {
  const load = vi.fn(() => []);
  expect(sessionDisplayName({ sessionId: 's', summary: 'Calendar sync' }, load)).toBe(
    'Calendar sync',
  );
  expect(
    sessionDisplayName(
      { sessionId: 's', summary: 'Merge it', initialPrompt: 'Fix calendar sync' },
      load,
    ),
  ).toBe('Fix calendar sync');
  expect(load).not.toHaveBeenCalled();
});

it.each(['```', '~~~', '````', '~~~~'])(
  'does not name a task from a %s code example in an assistant reply',
  (fence) => {
    const events = conversation(
      'Continue',
      `${fence}md\n## Example task\n[Wrong topic](https://github.com/dimakis/mitzo/pull/9)\n${fence}\nI’ll repair calendar sync.`,
    );
    expect(sessionDisplayName({ sessionId: 's', summary: 'Continue' }, events)).toBe(
      'Repair calendar sync',
    );
  },
);

it.each(['```', '~~~'])('ignores an unfinished %s example', (fence) => {
  const events = conversation(
    'Continue',
    `I’ll repair calendar sync.\n${fence}md\n## Example task\n[Wrong topic](https://github.com/dimakis/mitzo/pull/9)`,
  );
  expect(sessionDisplayName({ sessionId: 's', summary: 'Continue' }, events)).toBe(
    'Repair calendar sync',
  );
  expect(
    sessionDisplayName(
      { sessionId: 'chat-12345678', summary: 'Continue' },
      conversation('Continue', `${fence}md\n## Example task`),
    ),
  ).toBe('Chat 12345678');
});

it('requires a matching fence at least as long as its opener', () => {
  const events = conversation(
    'Continue',
    '````md\n```\n~~~\n[Wrong topic](https://github.com/dimakis/mitzo/pull/9)\n````\nI’ll repair calendar sync.',
  );
  expect(sessionDisplayName({ sessionId: 's', summary: 'Continue' }, events)).toBe(
    'Repair calendar sync',
  );
});

it.each(['> ', '- ', '    '])('ignores container-prefixed code examples (%j)', (prefix) => {
  const example = ['~~~md', '[Wrong topic](https://github.com/dimakis/mitzo/pull/9)', '~~~']
    .map((line) => prefix + line)
    .join('\n');
  const events = conversation('Continue', `${example}\nI’ll repair calendar sync.`);
  expect(sessionDisplayName({ sessionId: 's', summary: 'Continue' }, events)).toBe(
    'Repair calendar sync',
  );
});

it('keeps PR identifiers so similar tasks remain distinguishable', () => {
  for (const pr of [1210, 1211]) {
    const events = conversation(
      'Get it merged',
      `Merged [Fix chat recovery](https://github.com/dimakis/mitzo/pull/${pr}).`,
    );
    expect(sessionDisplayName({ sessionId: 's', summary: 'Get it merged' }, events)).toBe(
      `Mitzo #${pr}: Fix chat recovery`,
    );
  }
});
