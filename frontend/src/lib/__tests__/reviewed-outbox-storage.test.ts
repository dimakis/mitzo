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

const ordinaryBody = {
  version: 2,
  runOn: 'local',
  sessionId: 'prepared-chat',
  workspace: { kind: 'ordinary', workspaceId: '11111111-1111-4111-8111-111111111111' },
  clientMsgId: 'ordinary-command',
  capabilityRevision: 'caps-r1',
  runtime: {
    account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'routing-r1' },
    harness: 'codex',
    targetId: 'mac',
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
  payload: { text: 'Original ordinary command' },
};
it.each([false, true])(
  'journals accepted composer proof before retirement (failure=%s)',
  (fail) => {
    const disk = memory();
    const storage = createReviewedOutboxStorage(disk, 'https://one.test/local/send', 'local');
    const composerDraft = { storageKey: 'mitzo-draft-chat', revisionToken: 'exact-revision' };
    const entry = {
      body: ordinaryBody,
      scope: 1,
      ordinaryDelivery: { version: 2, phase: 'continue' },
      uncertain: false,
      composerDraft,
      localReceipt: { state: 'consumed', sessionId: ordinaryBody.sessionId },
    };
    storage.setItem('queue', JSON.stringify([entry]));
    const marker = `mitzo-draft-accepted:${encodeURIComponent(composerDraft.storageKey)}`;
    const write = disk.setItem;
    const events: string[] = [];
    vi.spyOn(disk, 'setItem').mockImplementation((key, value) => {
      events.push('write:' + key);
      if (fail && key === marker) throw Error('Journal quota');
      write(key, value);
    });
    const remove = disk.removeItem;
    vi.spyOn(disk, 'removeItem').mockImplementation((key) => {
      events.push('remove:' + key);
      remove(key);
    });
    if (fail) {
      expect(() => storage.setItem('queue', '[]')).toThrow('Journal quota');
      expect(JSON.parse(storage.getItem('queue')!)).toEqual([entry]);
    } else {
      storage.setItem('queue', '[]');
      expect(JSON.parse(disk.getItem(marker)!)).toEqual(composerDraft);
      expect(events[0]).toBe('write:' + marker);
      expect(events[1]).toMatch(/^remove:/);
      expect(storage.getItem('queue')).toBe('[]');
    }
  },
);
it.each(['first', 'continue'] as const)(
  'persists and manually recovers V2 %s through the actual browser adapter and existing outbox',
  async (phase) => {
    const { SendOutbox } = await import('../../../../packages/client/src/send-outbox');
    const disk = memory(),
      url = 'https://one.test/api/chat/local-codex/send';
    const notify = vi.fn(),
      fetch = vi.fn().mockRejectedValue(Error('lost response'));
    const outbox = new SendOutbox({
      url,
      storage: createReviewedOutboxStorage(disk, url, 'local'),
      localFirstCommand: true,
      notify,
      fetch,
    });
    outbox.start();
    expect(outbox.enqueue(ordinaryBody, 1, 'original-draft', { version: 2, phase })).toBe(true);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'uncertain' })),
    );
    outbox.stop();
    const accepted = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          sessionId: ordinaryBody.sessionId,
          clientMsgId: ordinaryBody.clientMsgId,
          dispatched: true,
          state: 'consumed',
        }),
        { status: 202 },
      ),
    );
    const restored = new SendOutbox({
      url,
      storage: createReviewedOutboxStorage(disk, url, 'local'),
      localFirstCommand: true,
      notify,
      fetch: accepted,
    });
    restored.start();
    expect(accepted).not.toHaveBeenCalled();
    expect(restored.retryLocalCommand()).toBe(true);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledged: true, sessionId: 'prepared-chat' }),
      ),
    );
    expect(accepted.mock.calls[0][0]).toBe(`/api/ordinary/workspaces/commands/${phase}`);
    expect(JSON.parse(accepted.mock.calls[0][1].body)).toEqual(ordinaryBody);
    expect(JSON.parse(createReviewedOutboxStorage(disk, url, 'local').getItem('queue')!)).toEqual(
      [],
    );
    restored.stop();
  },
);
it.each([undefined, { version: 2, phase: 'send' }, { version: 2, phase: 'first', grant: true }])(
  'refuses missing or forged V2 delivery metadata without retaining it: %j',
  (ordinaryDelivery) => {
    const disk = memory(),
      url = 'https://one.test/api/chat/local-codex/send';
    const storage = createReviewedOutboxStorage(disk, url, 'local');
    expect(() =>
      storage.setItem(
        'queue',
        JSON.stringify([{ body: ordinaryBody, scope: 1, ordinaryDelivery }]),
      ),
    ).toThrow();
    expect(disk.length).toBe(0);
  },
);
