import { afterEach, expect, it, vi } from 'vitest';
import { SendOutbox } from '../send-outbox.js';

const command = {
  runOn: 'openshell',
  repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'existing-chat',
  clientMsgId: 'accepted-follow-up',
  capabilityRevision: 'fixture-caps',
  runtime: {
    account: { accountId: 'work', provider: 'openai', profileRevision: 'fixture-r1' },
    harness: 'codex',
    targetId: 'openshell',
    mode: 'agent',
  },
  selection: {
    version: 1,
    agent: { profileId: 'agent', revision: 1 },
    model: 'luna-offline-fixture',
    thinking: 'low',
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
  },
  payload: { text: 'The request already accepted by the server' },
};
const response = () =>
  Response.json(
    {
      ok: true,
      clientMsgId: command.clientMsgId,
      sessionId: command.sessionId,
      dispatched: false,
      state: 'consumed',
    },
    { status: 202 },
  );
const pending = () => Response.json({ ok: false, code: 'receipt_pending' }, { status: 409 });
function setup(restored = false) {
  let raw = JSON.stringify(restored ? [{ body: command, scope: 1, uncertain: true }] : []);
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
  };
  const fetch = vi.fn<(_url: string, _init?: RequestInit) => Promise<Response>>();
  const notify = vi.fn();
  const outbox = new SendOutbox({
    url: '/local/send',
    storage,
    fetch,
    notify,
    localFirstCommand: true,
  });
  return { outbox, fetch, notify, retained: () => JSON.parse(raw) };
}
afterEach(() => vi.restoreAllMocks());

it('rechecks a receipt hint received while the previous read was still pending', async () => {
  const { outbox, fetch, notify, retained } = setup(true);
  let finish!: (value: Response) => void;
  fetch
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementation(async () => response());
  outbox.start();
  try {
    const first = outbox.reconcileLocalCommand(command.clientMsgId);
    await outbox.reconcileLocalCommand(command.clientMsgId);
    await outbox.reconcileLocalCommand(command.clientMsgId);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(pending());
    await first;
    await vi.waitFor(() => expect(retained()).toEqual([]));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => url === '/api/chat/runtime/continue/receipt')).toBe(
      true,
    );
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'consumed',
        acknowledged: true,
        clientMsgId: command.clientMsgId,
      }),
    );
  } finally {
    outbox.stop();
  }
});

it('checks a restored selected chat on reconnect without resubmitting its accepted command', async () => {
  const { outbox, fetch, notify, retained } = setup(true);
  fetch.mockImplementation(async () => pending());
  outbox.start();
  outbox.selectLocalSession(command.sessionId);
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    // The first observation could not yet prove acceptance; no response was resent.
    await Promise.resolve();
    expect(retained()).toHaveLength(1);
    fetch.mockImplementation(async () => response());
    outbox.wake();
    await vi.waitFor(() => expect(retained()).toEqual([]));
    expect(fetch.mock.calls.every(([url]) => url.endsWith('/receipt'))).toBe(true);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'consumed' }));
  } finally {
    outbox.stop();
  }
});

it('does not observe an offscreen retained command when another chat is selected', async () => {
  const { outbox, fetch, retained } = setup(true);
  fetch.mockImplementation(async () => response());
  outbox.start();
  outbox.selectLocalSession('different-chat');
  outbox.wake();
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
  expect(retained()).toHaveLength(1);
  outbox.stop();
});

it('does not accept a late receipt after authentication invalidation', async () => {
  const { outbox, fetch, notify, retained } = setup(true);
  let finish!: (value: Response) => void;
  fetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  outbox.start();
  const first = outbox.reconcileLocalCommand(command.clientMsgId);
  await outbox.reconcileLocalCommand(command.clientMsgId);
  outbox.rejectAll('Authentication changed');
  finish(response());
  await first;
  await Promise.resolve();
  expect(retained()).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls.some(([event]) => event.state === 'consumed')).toBe(false);
});

it('retains local composer revision proof across reload without including it in the wire request', async () => {
  let raw = '[]';
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, next: string) => {
      raw = next;
    },
  };
  const composerDraft = { storageKey: 'mitzo-draft:existing-chat', revisionToken: 'edit-123' };
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    throw Error('Response lost');
  });
  const first = new SendOutbox({
    url: '/local/send',
    storage,
    fetch,
    notify: vi.fn(),
    localFirstCommand: true,
  });
  first.start();
  expect(first.enqueue(command, 1, undefined, undefined, composerDraft)).toBe(true);
  await vi.waitFor(() => expect(JSON.parse(raw)[0].uncertain).toBe(true));
  expect(JSON.parse(raw)[0].composerDraft).toEqual(composerDraft);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(command);
  first.stop();
  const notify = vi.fn();
  const read = vi
    .fn<(_url: string, _init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async () => response());
  const restored = new SendOutbox({
    url: '/local/send',
    storage,
    fetch: read,
    notify,
    localFirstCommand: true,
  });
  restored.start();
  try {
    restored.selectLocalSession(command.sessionId);
    await vi.waitFor(() => expect(JSON.parse(raw)).toEqual([]));
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'consumed', composerDraft }),
    );
    expect(JSON.parse(String(read.mock.calls[0][1]?.body))).toEqual(command);
  } finally {
    restored.stop();
  }
});
