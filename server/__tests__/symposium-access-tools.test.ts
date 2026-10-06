import { afterEach, expect, it, vi } from 'vitest';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
import { SymposiumAccessRequests } from '../symposium-access-tools.js';
const services: SymposiumAccessRequests[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});
function fixture() {
  const abort = new AbortController();
  const execution = {
    sessionId: 'session',
    deliveryId: 'delivery',
    claimToken: 'claim',
    seat: {
      id: 'seat',
      name: 'Builder',
      accountBinding: {
        accountId: 'vertex',
        provider: 'anthropic-vertex',
        model: 'test',
        profileRevision: '1',
      },
    },
    provenance: { membershipGeneration: 1 },
    signal: abort.signal,
  } as unknown as SymposiumSeatExecution;
  const verify = vi.fn();
  const fetch = vi.fn().mockResolvedValue('External source: page');
  const service = new SymposiumAccessRequests(':memory:', {
    resolve: async (url) => ({
      url,
      origin: new URL(url).origin,
      addresses: [{ address: '127.0.0.1', family: 4 }],
    }),
    fetch,
  });
  services.push(service);
  const tool = service.createTools({
    execution,
    workdir: '/sandbox/workspaces/mgmt',
    verifyCurrent: verify,
  });
  return { abort, execution, verify, fetch, service, tool };
}
const call = { turnId: 'turn', callId: 'call' };
const request = {
  operation: 'request_access',
  url: 'http://localhost:8123/',
  reason: 'Read my HA instance',
};
it('waits for a user decision showing the actual seat account and resolved origin, then permits reads only in that attempt', async () => {
  const f = fixture();
  expect(f.tool.tools.map((tool) => tool.name)).toEqual([
    'RequestWebAccess',
    'RequestGithubPublish',
  ]);
  const pending = f.tool.executeTool('RequestWebAccess', request, f.abort.signal, call);
  await vi.waitFor(() => expect(f.service.list('session')).toHaveLength(1));
  const row = f.service.list('session')[0];
  expect(row).toMatchObject({
    status: 'pending',
    seatName: 'Builder',
    accountId: 'vertex',
    input: { origin: 'http://localhost:8123', resolvedAddresses: ['127.0.0.1'] },
  });
  expect(JSON.stringify(row)).not.toContain('claimToken');
  expect(f.fetch).not.toHaveBeenCalled();
  f.service.decide('session', row.id, row.hash, true);
  expect(await pending).toMatchObject({ isError: false });
  expect(
    await f.tool.executeTool(
      'RequestWebAccess',
      { operation: 'fetch', url: request.url, reason: 'Read' },
      f.abort.signal,
      { ...call, callId: 'fetch' },
    ),
  ).toMatchObject({ isError: false });
  expect(f.fetch).toHaveBeenCalledOnce();
});
it('rejects stale approval hashes, changed attempts and denied requests without making a read', async () => {
  const f = fixture();
  const pending = f.tool.executeTool('RequestWebAccess', request, f.abort.signal, call);
  await vi.waitFor(() => expect(f.service.list('session')).toHaveLength(1));
  const row = f.service.list('session')[0];
  expect(() => f.service.decide('session', row.id, 'stale', true)).toThrow();
  f.verify.mockImplementation(() => {
    throw new Error('seat removed');
  });
  expect(() => f.service.decide('session', row.id, row.hash, true)).toThrow();
  f.abort.abort();
  expect(await pending).toMatchObject({ isError: true });
  expect(f.fetch).not.toHaveBeenCalled();
});
it('queues publishing for artifact review and never treats a model request as publication authority', async () => {
  const f = fixture();
  expect(
    await f.tool.executeTool(
      'RequestGithubPublish',
      {
        repositoryPath: '/sandbox/workspaces/mgmt',
        baseBranch: 'main',
        title: 'Publish fix',
        body: 'Change',
        draft: true,
      },
      f.abort.signal,
      call,
    ),
  ).toMatchObject({ isError: false, content: expect.stringContaining('awaiting_artifact_review') });
  expect(f.service.list('session')[0]).toMatchObject({
    kind: 'publication',
    status: 'review_requested',
  });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(() =>
    f.service.decide(
      'session',
      f.service.list('session')[0].id,
      f.service.list('session')[0].hash,
      true,
    ),
  ).toThrow();
  const row = f.service.list('session')[0];
  expect(() => f.service.handoff('other', row.id, row.hash)).toThrow();
  expect(() => f.service.handoff('session', row.id, 'stale')).toThrow();
  f.service.handoff('session', row.id, row.hash);
  expect(f.service.list('session')[0].status).toBe('review_handed_off');
  expect(() => f.service.handoff('session', row.id, row.hash)).toThrow();
});
it('cannot reuse a previous executing claim grant or accept model-selected account identities', async () => {
  const f = fixture();
  expect(
    await f.tool.executeTool(
      'RequestWebAccess',
      { ...request, accountId: 'other' },
      f.abort.signal,
      call,
    ),
  ).toMatchObject({ isError: true });
  expect(f.service.list('session')).toEqual([]);
  expect(
    await f.tool.executeTool(
      'RequestGithubPublish',
      { repositoryPath: '/etc', baseBranch: 'main', title: 'bad', body: '', draft: false },
      f.abort.signal,
      call,
    ),
  ).toMatchObject({ isError: true });
  expect(f.service.list('session')).toEqual([]);
});

it('bounds simultaneous user approval cards for one seat', async () => {
  const f = fixture();
  const pending = [0, 1, 2].map((index) =>
    f.tool.executeTool(
      'RequestWebAccess',
      { ...request, url: `http://localhost:${8123 + index}/` },
      f.abort.signal,
      { ...call, callId: String(index) },
    ),
  );
  await vi.waitFor(() => expect(f.service.list('session')).toHaveLength(3));
  const extra = f.tool.executeTool(
    'RequestWebAccess',
    { ...request, url: 'http://localhost:9000/' },
    f.abort.signal,
    { ...call, callId: 'extra' },
  );
  try {
    expect(
      await Promise.race([
        extra,
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 100)),
      ]),
    ).toMatchObject({ isError: true });
  } finally {
    f.abort.abort();
    await Promise.all([...pending, extra]);
  }
});

it('keeps outstanding requests visible after more than fifty completed history records', async () => {
  const f = fixture();
  const pending = f.tool.executeTool('RequestWebAccess', request, f.abort.signal, call);
  await vi.waitFor(() => expect(f.service.list('session')).toHaveLength(1));
  const original = f.service.list('session')[0];
  for (let index = 0; index < 55; index++) {
    await f.tool.executeTool(
      'RequestGithubPublish',
      {
        repositoryPath: '/sandbox/workspaces/mgmt',
        baseBranch: 'main',
        title: 'History',
        body: '',
        draft: true,
      },
      f.abort.signal,
      { ...call, callId: `history-${index}` },
    );
    const row = f.service.list('session').find((item) => item.status === 'review_requested')!;
    f.service.dismiss('session', row.id, row.hash);
  }
  expect(f.service.list('session').find((item) => item.id === original.id)?.status).toBe('pending');
  f.abort.abort();
  await pending;
});
