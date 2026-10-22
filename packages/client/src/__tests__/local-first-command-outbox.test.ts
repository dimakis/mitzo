import { afterEach, expect, it, vi } from 'vitest';
import { SendOutbox } from '../send-outbox.js';
const command = {
  runOn: 'local',
  repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
  clientMsgId: 'local-first',
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
  payload: { text: 'inspect' },
};
const disk = () => {
  let raw: string | null = null;
  return {
    getItem: () => raw,
    setItem: (_: string, value: string) => {
      raw = value;
    },
  };
};
const receipt = (state = 'consumed') =>
  new Response(
    JSON.stringify({
      ok: true,
      clientMsgId: command.clientMsgId,
      sessionId: 'session',
      dispatched: state === 'consumed',
      state,
    }),
    { status: 202 },
  );
afterEach(() => vi.useRealTimers());
it('keeps the original durable receipt through a reentrant enqueue when handoff and rollback storage fail', async () => {
  const saved = disk();
  let writesBlocked = false;
  const storage = {
    getItem: saved.getItem,
    setItem: (key: string, value: string) => {
      if (writesBlocked) throw Error('Storage unavailable');
      saved.setItem(key, value);
    },
  };
  const next = { ...command, clientMsgId: 'new-explicit-command', payload: { text: 'New draft' } };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/receipt')) return receipt();
    if (JSON.parse(String(init?.body)).clientMsgId === command.clientMsgId)
      return new Promise<Response>(() => {});
    return Response.json(
      {
        ok: true,
        clientMsgId: next.clientMsgId,
        sessionId: 'next-session',
        dispatched: true,
        state: 'consumed',
      },
      { status: 202 },
    );
  });
  let failHandoff = true;
  const notify = vi.fn((event: Record<string, unknown>) => {
    if (event.clientMsgId === command.clientMsgId && event.state === 'consumed' && failHandoff) {
      expect(outbox.enqueue(next, 2, 'new-draft')).toBe(true);
      writesBlocked = true;
      throw Error('Source handoff unavailable');
    }
  });
  const outbox = new SendOutbox({
    url: '/local/send',
    fetch,
    storage,
    notify,
    localFirstCommand: true,
  });
  outbox.start();
  try {
    outbox.enqueue(command, 1, 'original-draft');
    await outbox.reconcileLocalCommand(command.clientMsgId);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ clientMsgId: command.clientMsgId, state: 'uncertain' }),
      ),
    );
    expect(JSON.parse(storage.getItem()!).map((entry: { body: unknown }) => entry.body)).toEqual([
      command,
      next,
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    failHandoff = false;
    writesBlocked = false;
    await outbox.reconcileLocalCommand(command.clientMsgId);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenLastCalledWith(
        expect.objectContaining({ clientMsgId: next.clientMsgId, state: 'consumed' }),
      ),
    );
    expect(
      fetch.mock.calls
        .filter(([url]) => url === '/local/send')
        .map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([command, next]);
    expect(JSON.parse(storage.getItem()!)).toEqual([]);
  } finally {
    writesBlocked = false;
    outbox.rejectAll('Fixture ended');
  }
});
it('retains a consumed receipt when its durable handoff fails, then finishes through observation without resending', async () => {
  const saved = disk();
  let writesBlocked = false;
  const storage = {
    getItem: saved.getItem,
    setItem: (key: string, value: string) => {
      if (writesBlocked) throw Error('Storage writes unavailable');
      saved.setItem(key, value);
    },
  };
  let failHandoff = true;
  const notify = vi.fn((event: Record<string, unknown>) => {
    if (event.state === 'consumed' && failHandoff) {
      writesBlocked = true;
      throw Error('Durable handoff unavailable');
    }
  });
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/receipt') ? receipt() : new Promise<Response>(() => {}),
  );
  const outbox = new SendOutbox({
    url: '/local/send',
    fetch,
    storage,
    notify,
    localFirstCommand: true,
  });
  outbox.start();
  try {
    outbox.enqueue(command, 1, 'original-draft');
    await outbox.reconcileLocalCommand(command.clientMsgId);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'uncertain' })),
    );
    const retained = JSON.parse(storage.getItem()!);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      body: command,
      localDraftId: 'original-draft',
      localReceipt: { sessionId: 'session', state: 'consumed' },
    });
    const reloadedNotify = vi.fn();
    const reloaded = new SendOutbox({
      url: '/local/send',
      fetch,
      storage,
      notify: reloadedNotify,
      localFirstCommand: true,
    });
    reloaded.start();
    expect(reloadedNotify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'uncertain',
        request: command,
        originDraftId: 'original-draft',
      }),
    );
    reloaded.stop();
    expect(fetch).toHaveBeenCalledTimes(2);
    writesBlocked = false;
    failHandoff = false;
    await outbox.reconcileLocalCommand(command.clientMsgId);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'consumed', acknowledged: true }),
    );
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/local/send',
      '/local/send/receipt',
      '/local/send/receipt',
    ]);
    expect(JSON.parse(storage.getItem()!)).toEqual([]);
  } finally {
    outbox.rejectAll('Fixture ended');
  }
});
it('recovers a lost acknowledgement through a read-only exact receipt without resending', async () => {
  const storage = disk(),
    notify = vi.fn();
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(Error('HTTP response lost'))
    .mockResolvedValueOnce(receipt());
  const outbox = new SendOutbox({
    url: '/local/send',
    fetch,
    storage,
    notify,
    localFirstCommand: true,
  });
  outbox.start();
  outbox.enqueue(command, 1, 'draft');
  await vi.waitFor(() =>
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'uncertain' })),
  );
  await outbox.reconcileLocalCommand(command.clientMsgId);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/local/send', '/local/send/receipt']);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(command);
  expect(notify).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'consumed', acknowledged: true }),
  );
  expect(JSON.parse(storage.getItem()!)).toEqual([]);
  outbox.stop();
});
it('bounds the entire receipt including a stalled HTTP body, retaining the exact command', async () => {
  vi.useFakeTimers();
  const storage = disk(),
    notify = vi.fn();
  let finishBody!: (value: unknown) => void;
  const fetch = vi.fn().mockResolvedValue({
    status: 202,
    json: () =>
      new Promise((resolve) => {
        finishBody = resolve;
      }),
  });
  const outbox = new SendOutbox({
    url: '/local/send',
    fetch,
    storage,
    notify,
    localFirstCommand: true,
    timeoutMs: 50,
  });
  outbox.start();
  outbox.enqueue(command, 1, 'draft');
  await vi.advanceTimersByTimeAsync(50);
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'uncertain' }));
  finishBody(await receipt().json());
  await vi.advanceTimersByTimeAsync(0);
  expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ acknowledged: true }));
  expect(JSON.parse(storage.getItem()!)[0].body).toEqual(command);
  expect(fetch).toHaveBeenCalledTimes(1);
  outbox.stop();
});

it('allows the server startup budget but still times out an unacknowledged command', async () => {
  vi.useFakeTimers();
  const storage = disk(),
    notify = vi.fn();
  const fetch = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
  const outbox = new SendOutbox({
    url: '/local/send',
    fetch,
    storage,
    notify,
    localFirstCommand: true,
  });
  outbox.start();
  outbox.enqueue(command, 1, 'draft');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'pending' }));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'uncertain' }));
  expect(JSON.parse(storage.getItem()!)[0].body).toEqual(command);
  expect(fetch).toHaveBeenCalledTimes(1);
  outbox.stop();
});

it.each([
  ['claude-sdk', 'anthropic-vertex'],
  ['responses', 'openai'],
  ['gemini', 'google-vertex'],
] as const)(
  'delivers local %s through the general runtime route for first and continuation commands',
  async (harness, provider) => {
    const storage = disk(),
      notify = vi.fn();
    const fetch = vi.fn().mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.includes('/local-codex/'))
        return new Response(
          JSON.stringify({ code: 'invalid_request', error: 'Invalid local first command' }),
          { status: 400 },
        );
      return new Response(
        JSON.stringify({
          ok: true,
          clientMsgId: body.clientMsgId,
          sessionId: 'runtime-session',
          state: 'consumed',
          dispatched: true,
        }),
        { status: 202 },
      );
    });
    const outbox = new SendOutbox({
      url: '/api/chat/local-codex/send',
      storage,
      notify,
      fetch,
      localFirstCommand: true,
    });
    outbox.start();
    const first = {
      ...command,
      runtime: { ...command.runtime, harness, account: { ...command.runtime.account, provider } },
    };
    expect(outbox.enqueue(first, 1, 'runtime-draft')).toBe(true);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'consumed', clientMsgId: first.clientMsgId }),
      ),
    );
    const continuation = {
      ...first,
      sessionId: 'runtime-session',
      clientMsgId: 'runtime-continuation',
    };
    expect(outbox.enqueue(continuation, 2)).toBe(true);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'consumed', clientMsgId: continuation.clientMsgId }),
      ),
    );
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/chat/runtime/send',
      '/api/chat/runtime/continue',
    ]);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      first,
      continuation,
    ]);
    expect(JSON.parse(storage.getItem()!)).toEqual([]);
    outbox.stop();
  },
);

it('lets a new draft send independently while retaining another draft’s frozen uncertain request', async () => {
  const storage = disk();
  const notify = vi.fn();
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(Error('old response lost'))
    .mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          ok: true,
          clientMsgId: body.clientMsgId,
          sessionId: 'fresh-session',
          dispatched: true,
          state: 'consumed',
        }),
        { status: 202 },
      );
    });
  const outbox = new SendOutbox({
    url: '/local/send',
    fetch,
    notify,
    storage,
    localFirstCommand: true,
  });
  outbox.start();
  expect(outbox.enqueue(command, 1, 'old-draft')).toBe(true);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'uncertain' })),
  );
  const fresh = { ...command, clientMsgId: 'fresh-first', payload: { text: 'Fresh initial send' } };
  outbox.selectLocalDraft('fresh-draft');
  expect(outbox.enqueue(fresh, 2, 'fresh-draft')).toBe(true);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'consumed', clientMsgId: 'fresh-first' }),
    ),
  );
  expect(JSON.parse(storage.getItem()!)).toEqual([
    expect.objectContaining({ body: command, localDraftId: 'old-draft', uncertain: true }),
  ]);
  expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([command, fresh]);
  outbox.selectLocalDraft('old-draft');
  expect(notify).toHaveBeenLastCalledWith(
    expect.objectContaining({ request: command, originDraftId: 'old-draft', state: 'uncertain' }),
  );
  expect(outbox.enqueue({ ...command, clientMsgId: 'replacement' }, 3, 'old-draft')).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('serializes independently submitted first commands without replaying an older retained entry', async () => {
  const storage = disk(),
    notify = vi.fn();
  let release!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          ok: true,
          clientMsgId: body.clientMsgId,
          sessionId: 'fresh-session',
          dispatched: true,
          state: 'consumed',
        }),
        { status: 202 },
      );
    });
  const outbox = new SendOutbox({
    url: '/local/send',
    fetch,
    notify,
    storage,
    localFirstCommand: true,
  });
  outbox.start();
  expect(outbox.enqueue(command, 1, 'old-draft')).toBe(true);
  const fresh = { ...command, clientMsgId: 'fresh-first' };
  expect(outbox.enqueue(fresh, 2, 'fresh-draft')).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  release(
    new Response(
      JSON.stringify({
        ok: false,
        code: 'retained_command',
        error: 'Local Codex entry unavailable',
        clientMsgId: command.clientMsgId,
        sessionId: 'old-session',
        state: 'uncertain',
      }),
      { status: 409 },
    ),
  );
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ clientMsgId: 'fresh-first', state: 'consumed' }),
    ),
  );
  expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([command, fresh]);
  expect(JSON.parse(storage.getItem()!)[0].body).toEqual(command);
});

it('requires durable exact intent before any request and rejects forged local bodies', () => {
  const fetch = vi.fn();
  const outbox = new SendOutbox({
    url: '/api/chat/local-codex/send',
    fetch,
    notify: vi.fn(),
    localFirstCommand: true,
    storage: {
      getItem: () => null,
      setItem: () => {
        throw Error('quota');
      },
    },
  });
  outbox.start();
  expect(outbox.enqueue(command, 1)).toBe(false);
  expect(outbox.enqueue({ ...command, cwd: '/forged' }, 1)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
it('freezes intent and retains lost-response uncertainty for explicit exact recovery', async () => {
  const storage = disk();
  const fetch = vi.fn().mockRejectedValue(Error('lost'));
  const notify = vi.fn();
  const outbox = new SendOutbox({
    url: '/api/chat/local-codex/send',
    fetch,
    notify,
    storage,
    localFirstCommand: true,
  });
  outbox.start();
  const body = structuredClone(command);
  expect(outbox.enqueue(body, 1)).toBe(true);
  body.payload.text = 'changed';
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: '_local_command_state', state: 'uncertain' }),
    ),
  );
  outbox.stop();
  const recoveredFetch = vi.fn().mockResolvedValue(receipt());
  const recovered = new SendOutbox({
    url: '/api/chat/local-codex/send',
    fetch: recoveredFetch,
    notify,
    storage,
    localFirstCommand: true,
  });
  recovered.start();
  expect(recoveredFetch).not.toHaveBeenCalled();
  expect(recovered.retryLocalCommand()).toBe(true);
  await vi.waitFor(() => expect(recoveredFetch).toHaveBeenCalledTimes(1));
  expect(JSON.parse(recoveredFetch.mock.calls[0][1].body)).toEqual(command);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'consumed', sessionId: 'session' }),
    ),
  );
});
it.each(['reserved', 'uncertain'])(
  'retains %s receipt and never silently loops or switches routes',
  async (state) => {
    const fetch = vi.fn().mockResolvedValue(receipt(state));
    const storage = disk();
    const notify = vi.fn();
    const outbox = new SendOutbox({
      url: '/api/chat/local-codex/send',
      fetch,
      notify,
      storage,
      localFirstCommand: true,
    });
    outbox.start();
    outbox.enqueue(command, 1);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ state, sessionId: 'session' })),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem()!)[0].body).toEqual(command);
    expect(outbox.enqueue({ ...command, clientMsgId: 'different' }, 2)).toBe(false);
  },
);
it('preserves an accepted but undispatched first send when authentication changes', async () => {
  const storage = disk(),
    notify = vi.fn();
  const fetch = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
  const outbox = new SendOutbox({ url: '/local', storage, notify, fetch, localFirstCommand: true });
  outbox.start();
  expect(outbox.enqueue(command, 1, 'draft-a')).toBe(true);
  const queued = { ...command, clientMsgId: 'queued-first' };
  expect(outbox.enqueue(queued, 2, 'draft-b')).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  outbox.rejectAll('authentication changed');
  expect(JSON.parse(storage.getItem()!).map((entry: { body: unknown }) => entry.body)).toEqual([
    command,
    queued,
  ]);
  outbox.start();
  outbox.selectLocalDraft('draft-b');
  expect(notify).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'uncertain', request: queued }),
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(outbox.retryLocalCommand('queued-first')).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  outbox.rejectAll('done');
});

it('keeps exact request after bounded409 and authentication loss; explicit recovery never rewrites it', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: false,
        code: 'retained_command',
        clientMsgId: 'local-first',
        sessionId: 'session',
        state: 'uncertain',
        error: 'Local Codex entry unavailable',
      }),
      { status: 409 },
    ),
  );
  const storage = disk();
  const notify = vi.fn();
  const outbox = new SendOutbox({
    url: '/api/chat/local-codex/send',
    fetch,
    notify,
    storage,
    localFirstCommand: true,
  });
  outbox.start();
  outbox.enqueue(command, 1);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'retained' })),
  );
  outbox.rejectAll('auth changed');
  outbox.start();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(storage.getItem()!)[0].body).toEqual(command);
});
it('blocks corrupt persisted intent rather than forgetting it and admitting a replacement', () => {
  const storage = disk();
  storage.setItem(
    '',
    JSON.stringify([{ body: { ...command, systemPrompt: 'forged' }, scope: 1, uncertain: true }]),
  );
  const outbox = new SendOutbox({
    url: '/local',
    fetch: vi.fn(),
    notify: vi.fn(),
    storage,
    localFirstCommand: true,
  });
  expect(outbox.enqueue(command, 1)).toBe(false);
});
it.each(['retained_command', 'unknown_code'])(
  'keeps409 consumed observation (%s) without accepting, erasing or replaying the request',
  async (code) => {
    const storage = disk();
    const notify = vi.fn();
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          code,
          clientMsgId: command.clientMsgId,
          sessionId: 'original-session',
          state: 'consumed',
          error: 'Local Codex entry unavailable',
        }),
        { status: 409 },
      ),
    );
    const outbox = new SendOutbox({
      url: '/local',
      fetch,
      notify,
      storage,
      localFirstCommand: true,
    });
    outbox.start();
    outbox.enqueue(command, 1, 'original-draft');
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ state: code === 'retained_command' ? 'retained' : 'uncertain' }),
      ),
    );
    expect(notify.mock.calls.some(([event]) => event.state === 'consumed')).toBe(false);
    expect(JSON.parse(storage.getItem()!)[0].body).toEqual(command);
    expect(JSON.parse(storage.getItem()!)[0].localDraftId).toBe('original-draft');
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('freezes continuation settings and refuses an acknowledgement for a different session', async () => {
  const notify = vi.fn();
  const fetch = vi.fn().mockResolvedValue(receipt());
  const storage = disk();
  const outbox = new SendOutbox({
    url: '/api/chat/local-codex/send',
    fetch,
    notify,
    storage,
    localFirstCommand: true,
  });
  outbox.start();
  const continuation = { ...structuredClone(command), sessionId: 'original-session' };
  expect(outbox.enqueue(continuation, 1)).toBe(true);
  continuation.selection.thinking = 'high';
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'uncertain' })),
  );
  expect(fetch.mock.calls[0][0]).toBe('/api/chat/local-codex/continue');
  expect(JSON.parse(fetch.mock.calls[0][1].body).selection.thinking).toBe('low');
  expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ acknowledged: true }));
  outbox.stop();
  const resumedFetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        clientMsgId: command.clientMsgId,
        sessionId: 'original-session',
        dispatched: true,
        state: 'consumed',
      }),
      { status: 202 },
    ),
  );
  const resumed = new SendOutbox({
    url: '/api/chat/local-codex/send',
    fetch: resumedFetch,
    notify,
    storage,
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
  expect(resumedFetch.mock.calls[0][0]).toBe('/api/chat/local-codex/continue');
  expect(JSON.parse(resumedFetch.mock.calls[0][1].body).selection.thinking).toBe('low');
});

it('uses runtime OpenShell routes and retains the original session on continuation', async () => {
  const notify = vi.fn();
  const fetch = vi.fn().mockResolvedValue(receipt());
  const outbox = new SendOutbox({
    url: '/api/chat/local-codex/send',
    fetch,
    notify,
    storage: disk(),
    localFirstCommand: true,
  });
  outbox.start();
  expect(
    outbox.enqueue(
      { ...command, runOn: 'openshell', runtime: { ...command.runtime, targetId: 'sandbox' } },
      1,
    ),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ acknowledged: true })),
  );
  expect(fetch.mock.calls[0][0]).toBe('/api/chat/runtime/send');
  expect(
    outbox.enqueue(
      {
        ...command,
        runOn: 'openshell',
        sessionId: 'session',
        runtime: { ...command.runtime, targetId: 'sandbox' },
      },
      2,
    ),
  ).toBe(true);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls[1][0]).toBe('/api/chat/runtime/continue');
});

it('retains a finite generic OpenShell observation without treating it as an acknowledgement', async () => {
  const notify = vi.fn();
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: false,
        code: 'retained_command',
        error: 'Conversation runtime unavailable',
        clientMsgId: command.clientMsgId,
        sessionId: 'original-sandbox',
        state: 'uncertain',
      }),
      { status: 409 },
    ),
  );
  const outbox = new SendOutbox({
    url: '/api/chat/local-codex/send',
    fetch,
    notify,
    storage: disk(),
    localFirstCommand: true,
  });
  outbox.start();
  expect(
    outbox.enqueue(
      { ...command, runOn: 'openshell', runtime: { ...command.runtime, targetId: 'sandbox' } },
      1,
    ),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'retained', sessionId: 'original-sandbox' }),
    ),
  );
  expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ acknowledged: true }));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('releases a stalled original HTTP send after exact receipt recovery so the next explicit command is not delayed', async () => {
  const storage = disk(),
    notify = vi.fn();
  const fresh = {
    ...command,
    clientMsgId: 'fresh-after-recovery',
    payload: { text: 'Next explicit command' },
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/receipt')) return receipt();
    const body = JSON.parse(String(init?.body));
    if (body.clientMsgId === command.clientMsgId) return new Promise<Response>(() => {});
    return new Response(
      JSON.stringify({
        ok: true,
        clientMsgId: fresh.clientMsgId,
        sessionId: 'next-session',
        dispatched: true,
        state: 'consumed',
      }),
      { status: 202 },
    );
  });
  const outbox = new SendOutbox({
    url: '/local/send',
    fetch,
    storage,
    notify,
    localFirstCommand: true,
  });
  outbox.start();
  try {
    outbox.enqueue(command, 1, 'original-draft');
    await outbox.reconcileLocalCommand(command.clientMsgId);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMsgId: command.clientMsgId,
        state: 'consumed',
        acknowledged: true,
      }),
    );
    outbox.enqueue(fresh, 2, 'fresh-draft');
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ clientMsgId: fresh.clientMsgId, state: 'consumed' }),
      ),
    );
    expect(
      fetch.mock.calls
        .filter(([url]) => url === '/local/send')
        .map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([command, fresh]);
    expect(JSON.parse(storage.getItem()!)).toEqual([]);
  } finally {
    outbox.rejectAll('Fixture ended');
  }
});
