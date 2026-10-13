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
