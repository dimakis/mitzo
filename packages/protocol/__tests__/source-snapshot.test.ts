import { expect, it } from 'vitest';
import { V2SendMessage } from '../src/ws-schemas-v2.js';

it('retains a dated source snapshot through validated send envelopes', () => {
  const sourceSnapshots = [
    { kind: 'briefing', date: '2026-10-09', revision: 'a'.repeat(64), content: 'Exact report' },
  ];
  const parsed = V2SendMessage.parse({
    type: 'send',
    sessionId: null,
    clientMsgId: 'source-launch',
    prompt: 'Discuss',
    sourceSnapshots,
  });
  expect(parsed).toMatchObject({ sourceSnapshots });
});
it('rejects excessive UTF-8 bytes, invalid calendar dates and multiple source snapshots', () => {
  const source = {
    kind: 'briefing',
    date: '2026-10-09',
    revision: 'a'.repeat(64),
    content: 'Report',
  };
  const message = {
    type: 'send',
    sessionId: null,
    clientMsgId: 'source-launch',
    prompt: 'Discuss',
  };
  expect(
    V2SendMessage.safeParse({
      ...message,
      sourceSnapshots: [{ ...source, content: '€'.repeat(700000) }],
    }).success,
  ).toBe(false);
  expect(
    V2SendMessage.safeParse({ ...message, sourceSnapshots: [{ ...source, date: '2026-02-30' }] })
      .success,
  ).toBe(false);
  expect(V2SendMessage.safeParse({ ...message, sourceSnapshots: [source, source] }).success).toBe(
    false,
  );
});
