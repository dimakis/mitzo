import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ApiToolCatalog } from '../api-tool-catalog.js';
import { admitApiTools } from '../api-tool-execution.js';
import {
  CredentialConnections,
  CredentialConnectionStore,
  type ConnectionSender,
} from '../credential-connections.js';
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
async function fixture() {
  const store = new CredentialConnectionStore(':memory:');
  const catalog = new ApiToolCatalog(':memory:');
  cleanup.push(
    () => store.close(),
    () => catalog.close(),
  );
  const send = vi.fn<ConnectionSender>(async () => ({
    status: 200,
    body: '{"entity_id":"sensor.office","state":"21","last_changed":"2026-10-17T00:00:00Z","attributes":{"private":"omit"}}',
  }));
  const vault = {
    save: vi.fn<ConnectionSender>(async () => ({ service: 'fixture', account: 'fixture' })),
    link: vi.fn(),
    read: vi.fn(async () => 'fake-secret'),
    remove: vi.fn(),
  };
  const service = new CredentialConnections(store, vault, send);
  const c = await service.create(
    {
      label: 'Fixture',
      serviceTemplate: 'home-assistant',
      endpoint: 'https://ha.example.com',
      auth: { kind: 'bearer' },
      methods: ['GET'],
      paths: ['/api/'],
    },
    { secret: 'fake-secret' },
  );
  const d = catalog.save(
    {
      id: randomUUID(),
      expectedVersion: 0,
      configuration: {
        template: 'home-assistant.state@1',
        label: 'Office',
        connectionId: c.id,
        entityId: 'sensor.office',
      },
    },
    service,
  );
  await catalog.verify(d.id, d.version, {
    service,
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  const entry = catalog.publish(d.id, d.version, service);
  send.mockClear();
  vault.read.mockClear();
  const approve = vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  }));
  let allowed = true;
  const options = {
    catalog,
    service,
    sessionId: 'chat',
    refs: [catalog.reference(entry)],
    approve: approve as never,
    stillAllowed: () => allowed,
    assertCurrent: () => {},
  };
  const tools = admitApiTools(options);
  return {
    store,
    catalog,
    c,
    send,
    vault,
    service,
    entry,
    tools,
    options,
    approve,
    revoke: () => {
      allowed = false;
    },
  };
}
it('exposes only pinned definitions and invokes the real connection boundary with scoped output', async () => {
  const f = await fixture();
  const name = f.tools.definitions[0].name;
  expect(f.tools.admitted[0].reference).toEqual(f.catalog.reference(f.entry));
  expect(
    await f.tools.execute('ConnectionRequest', {}, new AbortController().signal),
  ).toBeUndefined();
  expect(await f.tools.execute(name, {}, new AbortController().signal)).toEqual({
    isError: false,
    content: '{"entity_id":"sensor.office","state":"21","last_changed":"2026-10-17T00:00:00Z"}',
  });
  expect(f.approve).toHaveBeenCalledWith(
    'RequestConnectionAccess',
    expect.objectContaining({ connectionId: f.c.id }),
    expect.objectContaining({ forcePrompt: true, rememberSessionGrant: false }),
  );
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.send.mock.calls[0][0]).toMatchObject({
    method: 'GET',
    url: new URL('https://ha.example.com/api/states/sensor.office'),
  });
});
it('invalid input and changed scope fail before approval or credential reads', async () => {
  const f = await fixture();
  const name = f.tools.definitions[0].name;
  expect(
    (await f.tools.execute(name, { path: '/api/config' }, new AbortController().signal))?.isError,
  ).toBe(true);
  f.store.put({ ...f.service.connection(f.c.id), endpoint: 'https://other.example.com' });
  expect((await f.tools.execute(name, {}, new AbortController().signal))?.isError).toBe(true);
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.vault.read).not.toHaveBeenCalled();
});
it.each(['permission', 'connection', 'configuration', 'cancellation'])(
  'revocation during awaited approval blocks effects: %s',
  async (kind) => {
    const f = await fixture();
    const controller = new AbortController();
    f.approve.mockImplementationOnce(async (_name, input) => {
      if (kind === 'permission') f.revoke();
      if (kind === 'connection') f.service.disable(f.c.id, 1);
      if (kind === 'configuration')
        f.catalog.save(
          {
            id: f.entry.id.slice(4),
            expectedVersion: 1,
            configuration: {
              template: 'home-assistant.state@1',
              label: 'Changed',
              connectionId: f.c.id,
              entityId: 'sensor.other',
            },
          },
          f.service,
        );
      if (kind === 'cancellation') controller.abort();
      return { behavior: 'allow', updatedInput: input };
    });
    expect(
      (await f.tools.execute(f.tools.definitions[0].name, {}, controller.signal))?.isError,
    ).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.vault.read).not.toHaveBeenCalled();
  },
);
