import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ApiToolCatalog } from '../api-tool-catalog.js';
import { CredentialConnections, CredentialConnectionStore } from '../credential-connections.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
async function fixture() {
  const store = new CredentialConnectionStore(':memory:');
  const catalog = new ApiToolCatalog(':memory:');
  cleanup.push(
    () => store.close(),
    () => catalog.close(),
  );
  const send = vi.fn(async () => ({
    status: 200,
    body: JSON.stringify({
      entity_id: 'sensor.office',
      state: '21',
      last_changed: '2026-10-17T00:00:00Z',
      attributes: { private: 'omitted' },
    }),
  }));
  const vault = {
    save: vi.fn(async () => ({ service: 'fixture', account: 'fixture' })),
    link: vi.fn(),
    read: vi.fn(async () => 'fake-secret'),
    remove: vi.fn(),
  };
  const service = new CredentialConnections(store, vault, send);
  const connection = await service.create(
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
  const input = {
    id: randomUUID(),
    expectedVersion: 0,
    configuration: {
      template: 'home-assistant.state@1',
      label: 'Office state',
      connectionId: connection.id,
      entityId: 'sensor.office',
    },
  };
  const options = { service, signal: new AbortController().signal, assertCurrent: () => {} };
  return { catalog, service, store, connection, send, vault, input, options };
}
it('requires verified exact configuration before publishing a portable immutable receipt', async () => {
  const f = await fixture();
  const draft = f.catalog.save(f.input, f.service);
  expect(f.catalog.list()).toEqual([]);
  expect(() => f.catalog.publish(draft.id, draft.version, f.service)).toThrow(/verif/i);
  expect(f.send).not.toHaveBeenCalled();
  await f.catalog.verify(draft.id, draft.version, f.options);
  const entry = f.catalog.publish(draft.id, draft.version, f.service);
  expect(f.catalog.publish(draft.id, draft.version, f.service)).toEqual(entry);
  expect(entry).toMatchObject({ id: `api:${draft.id}`, behavior: 'read', version: 1 });
  const ref = f.catalog.reference(entry);
  expect(Object.keys(ref).sort()).toEqual(['id', 'revision', 'version']);
  expect(JSON.stringify(ref)).not.toMatch(/sensor|connection|https|secret/);
  expect(f.catalog.resolve(ref, f.service).definition.input_schema).toMatchObject({
    type: 'object',
    additionalProperties: false,
  });
  expect(f.service.sessions(f.connection.id)).toEqual([]);
});
it('rejects arbitrary templates, executable configuration, traversal and endpoint overrides before effects', async () => {
  const f = await fixture();
  for (const changes of [
    { template: 'custom' },
    { entityId: '../api/config' },
    { entityId: 'sensor.x?url=https://evil.test' },
    { endpoint: 'https://evil.test' },
    { method: 'POST' },
    { code: 'fetch()' },
    { headers: { Authorization: 'secret' } },
  ]) {
    expect(() =>
      f.catalog.save(
        { ...f.input, configuration: { ...f.input.configuration, ...changes } },
        f.service,
      ),
    ).toThrow();
  }
  expect(f.send).not.toHaveBeenCalled();
  expect(f.vault.read).not.toHaveBeenCalled();
});
it('rejects connection scope and template mismatches', async () => {
  const f = await fixture();
  for (const changes of [
    { paths: ['/other'] },
    { methods: ['POST'] },
    { serviceTemplate: 'custom' },
  ]) {
    f.store.put({ ...f.service.connection(f.connection.id), ...changes } as never);
    expect(() => f.catalog.save(f.input, f.service)).toThrow();
  }
  expect(f.send).not.toHaveBeenCalled();
});
it.each([
  { status: 403, body: '{}' },
  { status: 200, body: '{}' },
  { status: 200, body: '{"entity_id":"sensor.other","state":"1","last_changed":"today"}' },
])('failed verification cannot publish: %j', async (response) => {
  const f = await fixture();
  const draft = f.catalog.save(f.input, f.service);
  f.send.mockResolvedValue(response);
  await expect(f.catalog.verify(draft.id, draft.version, f.options)).rejects.toThrow();
  expect(() => f.catalog.publish(draft.id, draft.version, f.service)).toThrow(/verif/i);
  expect(f.service.sessions(f.connection.id)).toEqual([]);
});
it('fences concurrent edits, cancellation, connection drift and foreign receipts', async () => {
  const f = await fixture();
  const draft = f.catalog.save(f.input, f.service);
  let release!: () => void;
  f.send.mockImplementationOnce(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return { status: 200, body: '{}' };
  });
  const verification = f.catalog.verify(draft.id, draft.version, f.options);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  f.catalog.save(
    {
      ...f.input,
      expectedVersion: 1,
      configuration: { ...f.input.configuration, label: 'Changed' },
    },
    f.service,
  );
  release();
  await expect(verification).rejects.toThrow();
  expect(() => f.catalog.publish(draft.id, 2, f.service)).toThrow(/verif/i);
  await f.catalog.verify(draft.id, 2, f.options);
  const entry = f.catalog.publish(draft.id, 2, f.service);
  expect(() => f.catalog.resolve({ ...entry, revision: randomUUID() }, f.service)).toThrow(
    /unresolved/i,
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.catalog.verify(draft.id, 2, { ...f.options, signal: controller.signal }),
  ).rejects.toThrow();
  f.service.disable(f.connection.id, 1);
  expect(() => f.catalog.resolve(entry, f.service)).toThrow();
});
