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

it.each([
  ['local', false],
  ['local', true],
  ['openshell', false],
  ['openshell', true],
] as const)(
  'persists and reloads exact %s command (continuation=%s) through the real adapter without automatic replay',
  async (runOn, continuation) => {
    const { SendOutbox } = await import('../../../../packages/client/src/send-outbox');
    const disk = memory();
    const url = 'https://one.test/api/chat/local-codex/send';
    const body = {
      runOn,
      ...(continuation ? { sessionId: 'original-session' } : {}),
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      clientMsgId: 'retained-command',
      capabilityRevision: 'caps-r1',
      runtime: {
        account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'routing-r1' },
        harness: 'codex',
        targetId: runOn === 'local' ? 'mac' : 'sandbox',
        mode: 'agent',
      },
      selection: {
        version: 1,
        agent: { profileId: 'agent', revision: 1 },
        model: 'luna-fixture',
        thinking: 'low',
        context: { source: 'none', revision: null },
        permission: { mode: 'agent', revision: 0 },
      },
      payload: { text: 'Original prompt' },
    };
    const expected = structuredClone(body);
    const notify = vi.fn();
    const fetch = vi.fn().mockRejectedValue(Error('Lost acknowledgement'));
    const outbox = new SendOutbox({
      url,
      storage: createReviewedOutboxStorage(disk, url, 'local'),
      fetch,
      notify,
      localFirstCommand: true,
    });
    outbox.start();
    expect(outbox.enqueue(body, 1)).toBe(true);
    body.selection.thinking = 'high';
    body.payload.text = 'Edited draft';
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'uncertain' })),
    );
    outbox.stop();
    const resumedFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          clientMsgId: expected.clientMsgId,
          sessionId: 'original-session',
          dispatched: true,
          state: 'consumed',
        }),
        { status: 202 },
      ),
    );
    const resumed = new SendOutbox({
      url,
      storage: createReviewedOutboxStorage(disk, url, 'local'),
      fetch: resumedFetch,
      notify,
      localFirstCommand: true,
    });
    resumed.start();
    expect(resumedFetch).not.toHaveBeenCalled();
    expect(resumed.retryLocalCommand()).toBe(true);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledged: true, sessionId: 'original-session' }),
      ),
    );
    const endpoint =
      runOn === 'openshell'
        ? `/api/chat/runtime/${continuation ? 'continue' : 'send'}`
        : `https://one.test/api/chat/local-codex/${continuation ? 'continue' : 'send'}`;
    expect(resumedFetch.mock.calls[0][0]).toBe(endpoint);
    expect(JSON.parse(resumedFetch.mock.calls[0][1].body)).toEqual(expected);
    expect(JSON.parse(createReviewedOutboxStorage(disk, url, 'local').getItem('queue')!)).toEqual(
      [],
    );
  },
);
