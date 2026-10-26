import { expect, it, vi } from 'vitest';
import { SendOutbox } from '../send-outbox.js';
import { OrdinaryWorkspaceFirstCommandSchema } from '@mitzo/protocol';
const command = OrdinaryWorkspaceFirstCommandSchema.parse({
  version: 2,
  runOn: 'local',
  sessionId: 'prepared-ordinary',
  workspace: { kind: 'ordinary', workspaceId: '11111111-1111-4111-8111-111111111111' },
  clientMsgId: 'original-command',
  capabilityRevision: 'caps-r1',
  runtime: {
    account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
    harness: 'codex',
    targetId: 'mac',
    mode: 'agent',
  },
  selection: {
    version: 1,
    agent: { profileId: 'worker', revision: 1 },
    model: 'fixture-model',
    thinking: 'low',
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
  },
  payload: { text: 'Retain this ordinary draft' },
});
function fixture(raw: string | null = null) {
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
  };
  const notify = vi.fn(),
    fetch = vi.fn().mockRejectedValue(Error('lost response'));
  const outbox = new SendOutbox({
    url: '/api/chat/local-codex/send',
    storage,
    fetch,
    notify,
    localFirstCommand: true,
  });
  outbox.start();
  return { outbox, storage, notify, fetch, saved: () => JSON.parse(raw ?? '[]') };
}
const receipt = (extra = {}, status = 202) =>
  new Response(
    JSON.stringify({
      ok: true,
      clientMsgId: command.clientMsgId,
      sessionId: command.sessionId,
      state: 'consumed',
      dispatched: true,
      ...extra,
    }),
    { status },
  );
it('retains and retries a prepared repository first command with its exact local session scope and original first route after response loss', async () => {
  const { version, workspace, sessionId, ...body } = command;
  const request = { ...body, repositoryWorkspaceId: workspace.workspaceId };
  const delivery = { version: 1 as const, phase: 'first' as const, sessionId };
  const f = fixture();
  expect(f.outbox.enqueue(request, 1, undefined, delivery)).toBe(true);
  await vi.waitFor(() =>
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'uncertain' })),
  );
  f.outbox.stop();
  expect(f.saved()[0]).toMatchObject({
    body: request,
    ordinaryDelivery: delivery,
    uncertain: true,
  });
  const restored = fixture(JSON.stringify(f.saved()));
  expect(restored.fetch).not.toHaveBeenCalled();
  expect(
    restored.outbox.enqueue({ ...request, clientMsgId: 'replacement' }, 2, undefined, delivery),
  ).toBe(false);
  restored.fetch.mockResolvedValue(receipt());
  expect(restored.outbox.retryLocalCommand()).toBe(true);
  await vi.waitFor(() =>
    expect(restored.notify).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'consumed', ordinaryDelivery: delivery }),
    ),
  );
  expect(restored.fetch.mock.calls[0][0]).toBe('/api/chat/local-codex/send');
  expect(JSON.parse(restored.fetch.mock.calls[0][1].body)).toEqual(request);
});
it.each(['prepared', 'first', 'continue'] as const)(
  'admits %s for a different conversation while preserving same-session exclusion',
  async (phase) => {
    const f = fixture(
      JSON.stringify([
        {
          body: command,
          scope: 1,
          uncertain: true,
          ordinaryDelivery: { version: 2, phase: 'first' },
          localDraftId: 'older-draft',
        },
      ]),
    );
    const fresh = { ...command, sessionId: 'new-session', clientMsgId: 'new-first' };
    const { version, workspace, sessionId, ...body } = fresh;
    const request =
      phase === 'prepared' ? { ...body, repositoryWorkspaceId: workspace.workspaceId } : fresh;
    const delivery =
      phase === 'prepared'
        ? { version: 1 as const, phase: 'first' as const, sessionId }
        : { version: 2 as const, phase };
    expect(f.outbox.enqueue(request, 2, undefined, delivery)).toBe(true);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(f.notify).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'uncertain', clientMsgId: 'new-first' }),
      ),
    );
    expect(
      f.outbox.enqueue({ ...request, clientMsgId: 'replacement' }, 3, 'another-draft', delivery),
    ).toBe(false);
    expect(f.saved().map((entry: { body: unknown }) => entry.body)).toEqual([command, request]);
    f.outbox.stop();
  },
);

it('a repository first-command acknowledgement cannot consume another prepared chat identity', async () => {
  const { version, workspace, sessionId, ...body } = command;
  const request = { ...body, repositoryWorkspaceId: workspace.workspaceId };
  const f = fixture();
  f.fetch.mockResolvedValue(receipt({ sessionId: 'another-chat' }));
  expect(f.outbox.enqueue(request, 1, undefined, { version: 1, phase: 'first', sessionId })).toBe(
    true,
  );
  await vi.waitFor(() =>
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'uncertain' })),
  );
  expect(f.saved()).toHaveLength(1);
  expect(f.notify.mock.calls.some(([event]) => event.acknowledged)).toBe(false);
  f.outbox.stop();
});
it.each(['first', 'continue'] as const)(
  'retains explicit %s phase with its already prepared session and uses only the matching V2 route',
  async (phase) => {
    const f = fixture();
    f.fetch.mockResolvedValue(receipt());
    expect(f.outbox.enqueue(command, 1, 'original-draft', { version: 2, phase })).toBe(true);
    await vi.waitFor(() =>
      expect(f.notify).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'consumed', acknowledged: true }),
      ),
    );
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0][0]).toBe('/api/ordinary/workspaces/commands/' + phase);
    expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual(command);
    expect(f.saved()).toEqual([]);
  },
);
it('persists exact phase/settings/draft before delivery and recovers only on explicit retry after reload', async () => {
  const f = fixture(),
    input = structuredClone(command);
  expect(f.outbox.enqueue(input, 1, 'original-draft', { version: 2, phase: 'first' })).toBe(true);
  input.payload.text = 'newer draft';
  await vi.waitFor(() =>
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'uncertain' })),
  );
  f.outbox.stop();
  expect(f.saved()[0]).toMatchObject({
    body: command,
    ordinaryDelivery: { version: 2, phase: 'first' },
    localDraftId: 'original-draft',
    uncertain: true,
  });
  const restored = fixture(JSON.stringify(f.saved()));
  expect(restored.fetch).not.toHaveBeenCalled();
  expect(
    restored.outbox.enqueue({ ...command, clientMsgId: 'replacement' }, 2, undefined, {
      version: 2,
      phase: 'continue',
    }),
  ).toBe(false);
  restored.fetch.mockResolvedValue(receipt());
  expect(restored.outbox.retryLocalCommand()).toBe(true);
  await vi.waitFor(() =>
    expect(restored.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'consumed',
        originDraftId: 'original-draft',
        ordinaryDelivery: { version: 2, phase: 'first' },
      }),
    ),
  );
  expect(JSON.parse(restored.fetch.mock.calls[0][1].body)).toEqual(command);
});
it.each([
  undefined,
  { version: 2, phase: 'unknown' },
  { version: 1, phase: 'first' },
  { version: 2, phase: 'first', path: '/forged' },
])('blocks malformed persisted phase %j without forgetting or dispatching it', (delivery) => {
  const saved = JSON.stringify([
    {
      body: command,
      scope: 1,
      uncertain: true,
      ...(delivery ? { ordinaryDelivery: delivery } : {}),
    },
  ]);
  const f = fixture(saved);
  expect(f.notify).toHaveBeenCalledWith({ type: '_local_command_state', state: 'blocked' });
  expect(f.outbox.retryLocalCommand()).toBe(false);
  expect(f.outbox.enqueue(command, 2, undefined, { version: 2, phase: 'first' })).toBe(false);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(f.saved())).toBe(saved);
});
it('retains mismatched acknowledgement and matching409 as observations, sharing exclusion with legacy commands', async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(receipt({ sessionId: 'another-session' }));
  expect(f.outbox.enqueue(command, 1, undefined, { version: 2, phase: 'continue' })).toBe(true);
  await vi.waitFor(() =>
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'uncertain' })),
  );
  expect(f.saved()).toHaveLength(1);
  f.fetch.mockResolvedValue(
    receipt(
      {
        ok: false,
        code: 'retained_command',
        error: 'Local Codex entry unavailable',
        dispatched: undefined,
      },
      409,
    ),
  );
  expect(f.outbox.retryLocalCommand()).toBe(true);
  await vi.waitFor(() =>
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'retained' })),
  );
  const { version, sessionId, workspace, ...rest } = command;
  expect(f.outbox.enqueue({ ...rest, repositoryWorkspaceId: workspace.workspaceId }, 2)).toBe(
    false,
  );
  expect(f.saved()[0].body).toEqual(command);
  expect(f.notify.mock.calls.some(([event]) => event.acknowledged)).toBe(false);
  f.outbox.rejectAll('auth revoked');
  f.outbox.start();
  expect(f.fetch.mock.calls.filter(([url]) => !url.endsWith('/receipt'))).toHaveLength(2);
  expect(f.fetch.mock.calls.at(-1)![0]).toBe('/api/ordinary/workspaces/commands/continue/receipt');
  f.outbox.stop();
});
