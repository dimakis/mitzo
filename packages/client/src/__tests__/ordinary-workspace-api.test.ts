import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OrdinaryWorkspaceApiClient } from '../ordinary-workspace-api.js';
import { OrdinaryWorkspaceFirstCommandSchema } from '@mitzo/protocol';
const account = { accountId: 'offline', provider: 'openai-codex' as const, profileRevision: 'r1' };
const command = OrdinaryWorkspaceFirstCommandSchema.parse({
  version: 2,
  runOn: 'local',
  sessionId: 'ordinary',
  workspace: { kind: 'ordinary', workspaceId: randomUUID() },
  clientMsgId: randomUUID(),
  capabilityRevision: 'c1',
  runtime: { account, harness: 'codex', targetId: 'local', mode: 'agent' },
  selection: {
    version: 1,
    agent: { profileId: 'ordinary-worker', revision: 1 },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'fixture-model',
    thinking: 'low',
  },
  payload: { text: 'Keep this draft' },
});
it('sends explicit ordinary command kind and original IDs exactly once and validates acknowledgement identity', async () => {
  const receipt = {
    ok: true,
    clientMsgId: command.clientMsgId,
    sessionId: command.sessionId,
    dispatched: true,
    state: 'consumed',
  };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt)));
  expect(await new OrdinaryWorkspaceApiClient(fetch).firstCommand(command)).toEqual(receipt);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe('/api/ordinary/workspaces/commands/first');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(command);
  fetch.mockResolvedValue(new Response(JSON.stringify({ ...receipt, clientMsgId: 'foreign' })));
  await expect(new OrdinaryWorkspaceApiClient(fetch).continueCommand(command)).rejects.toThrow(
    'Original ordinary command acknowledgement required',
  );
});
it('retains a matching uncertain observation as an error without acknowledgement, automatic retry or replacement IDs', async () => {
  const body = {
    ok: false,
    code: 'retained_command',
    error: 'Local Codex entry unavailable',
    clientMsgId: command.clientMsgId,
    sessionId: command.sessionId,
    state: 'uncertain',
  };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 409 }));
  await expect(new OrdinaryWorkspaceApiClient(fetch).firstCommand(command)).rejects.toMatchObject({
    status: 409,
    observation: body,
  });
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValue(
    new Response(JSON.stringify({ ...body, sessionId: 'foreign' }), { status: 409 }),
  );
  await expect(
    new OrdinaryWorkspaceApiClient(fetch).continueCommand(command),
  ).rejects.toMatchObject({ status: 409, observation: undefined });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('refuses physical path/client grant additions before sending', () => {
  const fetch = vi.fn();
  expect(() =>
    new OrdinaryWorkspaceApiClient(fetch).firstCommand({ ...command, cwd: '/fake-root' } as never),
  ).toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
