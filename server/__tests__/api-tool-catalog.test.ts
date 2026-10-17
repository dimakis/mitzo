import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { reviewedHandlerSourceArtifacts } from '../connections/reviewed-handler-artifacts.js';
vi.mock('../connections/reviewed-handler-artifacts.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../connections/reviewed-handler-artifacts.js')>();
  return {
    ...actual,
    reviewedHandlerSourceArtifacts: { ...actual.reviewedHandlerSourceArtifacts },
  };
});
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

it('a changed execution helper cannot silently replace a verified implementation', async () => {
  const f = await fixture();
  const draft = f.catalog.save(f.input, f.service);
  await f.catalog.verify(draft.id, 1, f.options);
  const entry = f.catalog.publish(draft.id, 1, f.service);
  // The test module substitutes a mutable copy of the production frozen manifest.
  const artifacts = reviewedHandlerSourceArtifacts as Record<string, string>;
  const original = artifacts['../credential-connections.ts'];
  artifacts['../credential-connections.ts'] = 'a'.repeat(64);
  try {
    expect(() => f.catalog.resolve(entry, f.service)).toThrow(/changed/);
    await expect(f.catalog.verify(draft.id, 1, f.options)).rejects.toThrow();
    const rebound = f.catalog.save({ ...f.input, expectedVersion: 1 }, f.service);
    await f.catalog.verify(draft.id, rebound.version, f.options);
    const next = f.catalog.publish(draft.id, rebound.version, f.service);
    expect(next.version).toBe(2);
    expect(next.revision).not.toBe(entry.revision);
    expect(() => f.catalog.resolve(entry, f.service)).toThrow();
    expect(f.catalog.resolve(next, f.service).configuration).toEqual(f.input.configuration);
  } finally {
    artifacts['../credential-connections.ts'] = original;
  }
});
it.each(['failed-newer-verification', 'cancellation'])(
  'an awaited successful response cannot restore stale proof after %s',
  async (kind) => {
    const f = await fixture();
    const draft = f.catalog.save(f.input, f.service);
    await f.catalog.verify(draft.id, 1, f.options);
    const published = f.catalog.publish(draft.id, 1, f.service);
    let release!: () => void;
    f.send.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        status: 200,
        body: '{"entity_id":"sensor.office","state":"21","last_changed":"2026-10-17T00:00:00Z"}',
      };
    });
    const controller = new AbortController();
    const pending = f.catalog.verify(draft.id, 1, { ...f.options, signal: controller.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (kind === 'cancellation') controller.abort();
    else {
      f.send.mockResolvedValueOnce({ status: 403, body: '{}' });
      await expect(f.catalog.verify(draft.id, 1, f.options)).rejects.toThrow();
    }
    release();
    await expect(pending).rejects.toThrow();
    expect(() => f.catalog.publish(draft.id, 1, f.service)).toThrow();
    expect(() => f.catalog.resolve(published, f.service)).toThrow();
    expect(f.service.sessions(f.connection.id)).toEqual([]);
  },
);

it('rejects noncanonical tool IDs before creating an unselectable publication', async () => {
  const f = await fixture();
  expect(() =>
    f.catalog.save({ ...f.input, id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, f.service),
  ).toThrow();
  expect(f.catalog.drafts()).toEqual([]);
  expect(f.send).not.toHaveBeenCalled();
});
