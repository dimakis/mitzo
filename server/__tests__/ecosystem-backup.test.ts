import { afterEach, expect, it } from 'vitest';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { captureWorkspace, sqliteSnapshot } from '../backup/capture.js';
import { ResticRepository } from '../backup/restic.js';
import { ICloudBackupTransport } from '../backup/icloud-transport.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ecosystem-backup-'));
  roots.push(root);
  return root;
}
it('refuses incomplete required coverage before any snapshot or barrier runs', async () => {
  const root = await fixture();
  let entered = false;
  await expect(
    captureWorkspace({
      destination: join(root, 'capture'),
      required: ['telos', 'documents'],
      adapters: [],
      withBarrier: async (work) => {
        entered = true;
        return work();
      },
    }),
  ).rejects.toThrow('coverage');
  expect(entered).toBe(false);
});
it('captures DB-only Telos relationships and bytes under one explicit barrier', async () => {
  const root = await fixture();
  const db = new Database(join(root, 'live.db'));
  db.pragma('journal_mode = WAL');
  db.exec(
    "CREATE TABLE items(id TEXT, parent TEXT, session TEXT); INSERT INTO items VALUES('child','parent','session');",
  );
  let held = false;
  try {
    await captureWorkspace({
      destination: join(root, 'capture'),
      required: ['telos', 'documents'],
      withBarrier: async (work) => {
        held = true;
        try {
          return await work();
        } finally {
          held = false;
        }
      },
      adapters: [
        {
          id: 'telos',
          async capture(path) {
            expect(held).toBe(true);
            await sqliteSnapshot(db, join(path, 'telos.db'));
            return { watermark: 'fixture-1' };
          },
        },
        {
          id: 'documents',
          async capture(path) {
            expect(held).toBe(true);
            await writeFile(join(path, 'attachment.bin'), 'attachment-bytes');
            return { watermark: 'fixture-1' };
          },
        },
      ],
    });
    const restored = new Database(join(root, 'capture', 'telos', 'telos.db'), { readonly: true });
    try {
      expect(restored.prepare('SELECT * FROM items').get()).toEqual({
        id: 'child',
        parent: 'parent',
        session: 'session',
      });
    } finally {
      restored.close();
    }
    expect(
      JSON.parse(await readFile(join(root, 'capture', 'coverage.json'), 'utf8')).stores,
    ).toHaveLength(2);
  } finally {
    db.close();
  }
});
it('does not finalize a failed capture and preserves existing target work', async () => {
  const root = await fixture();
  const destination = join(root, 'capture');
  await expect(
    captureWorkspace({
      destination,
      required: ['telos'],
      withBarrier: (work) => work(),
      adapters: [
        {
          id: 'telos',
          async capture() {
            throw new Error('private failure');
          },
        },
      ],
    }),
  ).rejects.toThrow('capture');
  await mkdir(destination);
  await writeFile(join(destination, 'newer-work'), 'preserve');
  await expect(
    captureWorkspace({
      destination,
      required: ['telos'],
      withBarrier: (work) => work(),
      adapters: [
        {
          id: 'telos',
          async capture() {
            return { watermark: '1' };
          },
        },
      ],
    }),
  ).rejects.toThrow();
  expect(await readFile(join(destination, 'newer-work'), 'utf8')).toBe('preserve');
});
it('rejects owner snapshots containing symlinks before finalizing coverage', async () => {
  const root = await fixture();
  await writeFile(join(root, 'outside'), 'synthetic-private');
  await expect(
    captureWorkspace({
      destination: join(root, 'capture'),
      required: ['documents'],
      withBarrier: (work) => work(),
      adapters: [
        {
          id: 'documents',
          async capture(path) {
            await symlink(join(root, 'outside'), join(path, 'escape'));
            return { watermark: '1' };
          },
        },
      ],
    }),
  ).rejects.toThrow('capture');
});
it('requires a specific recovery confirmation before encryption or export', async () => {
  const root = await fixture();
  expect(
    () =>
      new ResticRepository({
        binary: '/not-used',
        repository: join(root, 'repo'),
        scratch: join(root, 'scratch'),
        password: async () => 'fixture-secret',
        recoveryConfirmed: false,
      }),
  ).toThrow('recovery');
});
it('passes the recovery password only in the trusted child environment, never a file', async () => {
  const root = await fixture();
  const binary = join(root, 'fake-restic');
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
if (process.env.RESTIC_PASSWORD !== 'synthetic-secret' ||
    process.argv.includes('--password-file') ||
    fs.readdirSync(process.env.TMPDIR).length !== 0 ||
    process.env.HOME !== undefined) process.exit(1);
console.log('[]');
`,
  );
  await chmod(binary, 0o700);
  await mkdir(join(root, 'repo'));
  const repo = new ResticRepository({
    binary,
    repository: join(root, 'repo'),
    scratch: join(root, 'scratch'),
    password: async () => 'synthetic-secret',
    recoveryConfirmed: true,
  });
  await repo.initialize();
});
// Opt-in synthetic executable test. No models, accounts, Keychain, or iCloud involved.
it.runIf(!!process.env.MITZO_TEST_RESTIC_BINARY)(
  'round-trips a real encrypted deduplicated repository after deleting every source',
  async () => {
    const root = await fixture();
    const source = join(root, 'source');
    await mkdir(source);
    await writeFile(join(source, 'private.txt'), 'SYNTHETIC-PRIVATE-EVIDENCE');
    const password = async () => 'synthetic-test-recovery-password';
    const repo = new ResticRepository({
      binary: process.env.MITZO_TEST_RESTIC_BINARY!,
      repository: join(root, 'repo'),
      scratch: join(root, 'scratch'),
      password,
      recoveryConfirmed: true,
    });
    await repo.initialize();
    const snapshot = await repo.backup(source);
    await repo.check();
    const cloud = join(root, 'simulated-icloud');
    const transport = new ICloudBackupTransport(cloud, async () => 'unknown');
    const generation = await transport.publish(join(root, 'repo'));
    expect(generation.status).toBe('pending');
    await rm(source, { recursive: true });
    await rm(join(root, 'repo'), { recursive: true });
    await transport.restore(generation.id, join(root, 'reconstructed'));
    const recovered = new ResticRepository({
      binary: process.env.MITZO_TEST_RESTIC_BINARY!,
      repository: join(root, 'reconstructed'),
      scratch: join(root, 'scratch'),
      password,
      recoveryConfirmed: true,
    });
    await recovered.check();
    await recovered.restore(snapshot, join(root, 'restored'));
    expect(await readFile(join(root, 'restored', 'private.txt'), 'utf8')).toBe(
      'SYNTHETIC-PRIVATE-EVIDENCE',
    );
  },
  30000,
);
