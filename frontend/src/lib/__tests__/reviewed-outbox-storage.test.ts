import { expect, it, vi } from 'vitest';
import { createReviewedOutboxStorage } from '../reviewed-outbox-storage';
function memory() {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}
const command = (id: string) => ({
  body: {
    type: 'send',
    sessionId: null,
    clientMsgId: id,
    prompt: 'Discuss captured briefing',
    accountId: 'work',
    model: 'luna',
    sourceSnapshots: [
      {
        kind: 'briefing',
        date: '2026-10-09',
        revision: 'a'.repeat(64),
        content: 'Original report',
      },
    ],
  },
  scope: 1,
});
it('keeps exact full reviewed commands across WebView recreation without sessionStorage', () => {
  const disk = memory();
  const first = createReviewedOutboxStorage(disk, 'https://one.test/api/chat/send');
  first.setItem('queue', JSON.stringify([command('original')]));
  const fresh = createReviewedOutboxStorage(disk, 'https://one.test/api/chat/send');
  expect(JSON.parse(fresh.getItem('queue')!)).toEqual([command('original')]);
});
it('isolates backend namespaces and does not clobber a concurrently queued command', () => {
  const disk = memory();
  const a = createReviewedOutboxStorage(disk, 'https://one.test/api/chat/send');
  const b = createReviewedOutboxStorage(disk, 'https://one.test/api/chat/send');
  expect(a.getItem('queue')).toBe('[]');
  expect(b.getItem('queue')).toBe('[]');
  a.setItem('queue', JSON.stringify([command('a')]));
  b.setItem('queue', JSON.stringify([command('b')]));
  const fresh = createReviewedOutboxStorage(disk, 'https://one.test/api/chat/send');
  expect(
    JSON.parse(fresh.getItem('queue')!)
      .map((entry: ReturnType<typeof command>) => entry.body.clientMsgId)
      .sort(),
  ).toEqual(['a', 'b']);
  a.setItem('queue', '[]');
  expect(JSON.parse(fresh.getItem('queue')!)).toEqual([command('b')]);
  expect(createReviewedOutboxStorage(disk, 'https://two.test/api/chat/send').getItem('queue')).toBe(
    '[]',
  );
});
it('rejects oversized or malformed queues before retaining any command', () => {
  const disk = memory();
  const storage = createReviewedOutboxStorage(disk, 'https://one.test/api/chat/send');
  expect(() =>
    storage.setItem(
      'queue',
      JSON.stringify(Array.from({ length: 101 }, (_, index) => command(String(index)))),
    ),
  ).toThrow();
  expect(disk.length).toBe(0);
  expect(() =>
    storage.setItem(
      'queue',
      JSON.stringify([
        {
          ...command('one'),
          body: {
            ...command('one').body,
            sourceSnapshots: [
              {
                ...command('one').body.sourceSnapshots[0],
                content: 'x'.repeat(2 * 1024 * 1024 + 1),
              },
            ],
          },
        },
      ]),
    ),
  ).toThrow();
  expect(disk.length).toBe(0);
});
it('supports the valid 2MiB source worst JSON escaping without truncation', () => {
  const disk = memory();
  const storage = createReviewedOutboxStorage(disk, 'https://one.test/api/chat/send');
  const entry = command('maximum');
  entry.body.sourceSnapshots[0].content = '\0'.repeat(2 * 1024 * 1024);
  storage.setItem('queue', JSON.stringify([entry]));
  expect(
    JSON.parse(
      createReviewedOutboxStorage(disk, 'https://one.test/api/chat/send').getItem('queue')!,
    ),
  ).toEqual([entry]);
});

it('does not retain a new command when its durable write fails after an existing queue', () => {
  const disk = memory();
  const storage = createReviewedOutboxStorage(disk, 'https://one.test/api/chat/send');
  storage.setItem('queue', JSON.stringify([command('existing')]));
  const original = disk.setItem;
  vi.spyOn(disk, 'setItem').mockImplementation((key, value) => {
    if (key.endsWith(':new')) throw new Error('Quota');
    original(key, value);
  });
  expect(() =>
    storage.setItem('queue', JSON.stringify([command('existing'), command('new')])),
  ).toThrow('Quota');
  expect(
    JSON.parse(
      createReviewedOutboxStorage(disk, 'https://one.test/api/chat/send').getItem('queue')!,
    ),
  ).toEqual([command('existing')]);
});
