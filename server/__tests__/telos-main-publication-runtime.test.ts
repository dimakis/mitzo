import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import {
  readTelosMainPublicationConfiguration,
  installTelosMainPublicationRuntime,
  initializeTelosMainPublicationRuntime,
  getTelosMainPublicationRuntime,
  closeTelosMainPublicationRuntime,
} from '../telos-main-publication-runtime.js';
import { CredentialResolver } from '../credentials.js';
import { PublicationCredentialCustodian } from '../symposium-publication-credentials.js';
import { EventStore } from '../event-store.js';
import { config } from './fixtures/github-main-publication.js';
import type { NativeMainPublicationCall } from '../telos-main-publication-host.js';

const roots: string[] = [];
const databases: EventStore[] = [];
afterEach(() => {
  closeTelosMainPublicationRuntime();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-main-install-'));
  roots.push(root);
  const path = join(root, 'configuration.json');
  const entry = {
    ...config,
    label: 'Explicit merge capability',
    accountId: 'selected-account',
    repositoryId: 101,
    repositoryNodeId: 'R_original',
    credentialRef: { provider: 'test', service: 'github', account: 'operator' },
  };
  const document = { version: 1, registrations: [entry] };
  const write = (value: unknown = document) => {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  };
  write();
  let reads = 0;
  const resolver = new CredentialResolver({
    test: {
      async resolve() {
        reads++;
        throw Error('No live credentials');
      },
    },
  });
  const events = new EventStore(join(root, 'events.db'));
  databases.push(events);
  const registry = new SessionRegistry();
  const owners = {
    registry,
    events,
    databasePath: () => join(root, 'missing-canonical.db'),
    registrations: [entry],
    custodian: new PublicationCredentialCustodian(resolver),
  };
  return { root, path, entry, document, write, owners, reads: () => reads };
}
it('loads only private explicit metadata and installs without credential reads or a database', () => {
  const f = fixture();
  expect(readTelosMainPublicationConfiguration(f.path)).toEqual(f.document);
  const runtime = installTelosMainPublicationRuntime(f.owners);
  expect(runtime.supports(f.owners.registry, f.owners.events, 'selected-account')).toBe(true);
  expect(runtime.supports(new SessionRegistry(), f.owners.events, 'selected-account')).toBe(false);
  expect(runtime.supports(f.owners.registry, f.owners.events, 'other-account')).toBe(false);
  expect(f.reads()).toBe(0);
});
it('rejects symlink, writable, oversized and malformed configuration without fallback', () => {
  const f = fixture();
  symlinkSync(f.path, join(f.root, 'alias'));
  expect(() => readTelosMainPublicationConfiguration(join(f.root, 'alias'))).toThrow(/unavailable/);
  chmodSync(f.path, 0o620);
  expect(() => readTelosMainPublicationConfiguration(f.path)).toThrow(/unavailable/);
  chmodSync(f.path, 0o600);
  for (const bad of [
    { ...f.document, token: 'not-permitted' },
    { version: 2, registrations: [] },
    { version: 1, registrations: [{ ...f.entry, credential: 'forbidden' }] },
  ]) {
    f.write(bad);
    expect(() => readTelosMainPublicationConfiguration(f.path)).toThrow(/unavailable/);
  }
  writeFileSync(f.path, Buffer.alloc(1024 * 1024 + 1));
  expect(() => readTelosMainPublicationConfiguration(f.path)).toThrow(/unavailable/);
  expect(() => readTelosMainPublicationConfiguration('relative.json')).toThrow(/unavailable/);
  expect(f.reads()).toBe(0);
});
it('retires the original runtime before replacement and never revives it on invalid configuration', () => {
  const f = fixture(),
    first = installTelosMainPublicationRuntime(f.owners);
  const second = installTelosMainPublicationRuntime({
    ...f.owners,
    custodian: new PublicationCredentialCustodian(new CredentialResolver({})),
  });
  expect(getTelosMainPublicationRuntime()).toBe(second);
  expect(first.supports(f.owners.registry, f.owners.events, 'selected-account')).toBe(false);
  first.close();
  expect(getTelosMainPublicationRuntime()).toBe(second);
  expect(() => initializeTelosMainPublicationRuntime(f.owners, join(f.root, 'absent'))).toThrow();
  expect(getTelosMainPublicationRuntime()).toBeUndefined();
  expect(second.supports(f.owners.registry, f.owners.events, 'selected-account')).toBe(false);
  expect(f.reads()).toBe(0);
});
it('refuses asynchronous native authority before opening any canonical store or selecting credentials', async () => {
  const f = fixture(),
    runtime = installTelosMainPublicationRuntime(f.owners);
  for (const assertion of [
    async () => {},
    async () => {
      throw Error('revoked');
    },
    () => true,
  ]) {
    const context = { assertCurrentSync: assertion } as unknown as NativeMainPublicationCall;
    await expect(runtime.request(context, {})).rejects.toThrow(/unavailable/);
  }
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.reads()).toBe(0);
});

it('keeps source and artifact host metadata available without configuring a GitHub credential', () => {
  const f = fixture();
  const runtime = initializeTelosMainPublicationRuntime(f.owners, '');
  expect(runtime.supportsHost(f.owners.registry, f.owners.events)).toBe(true);
  expect(runtime.supports(f.owners.registry, f.owners.events, 'selected-account')).toBe(false);
  expect(f.reads()).toBe(0);
});
it('expires a retained native scope on runtime replacement across an actual renewal wait', async () => {
  const f = fixture(),
    runtime = installTelosMainPublicationRuntime(f.owners);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = {
    signal: new AbortController().signal,
    assertCurrentSync() {},
    async assertCurrent() {
      await waiting;
    },
  } as import('../native-host-tool-context.js').NativeHostToolContext;
  const scoped = runtime.bindNativeContext(context);
  const renewal = scoped.assertCurrent();
  closeTelosMainPublicationRuntime();
  release();
  await expect(renewal).rejects.toThrow(/unavailable/);
  expect(scoped.signal.aborted).toBe(true);
  expect(() => scoped.assertCurrentSync()).toThrow(/unavailable/);
  expect(f.reads()).toBe(0);
});
