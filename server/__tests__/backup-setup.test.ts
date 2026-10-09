import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupSetup } from '../backup/setup.js';
import { BackupService } from '../backup/service.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const folder = await mkdtemp(join(await realpath(tmpdir()), 'backup-onboarding-'));
  roots.push(folder);
  const root = join(folder, 'local');
  const capture = vi.fn(async () => {});
  const driver = {
    capture,
    initialize: vi.fn(async () => {}),
    backup: vi.fn(async () => 'a'.repeat(64)),
    check: vi.fn(async () => {}),
    publish: vi.fn(async () => ({ id: 'unused', status: 'pending' as const, bytes: 1 })),
    refresh: vi.fn(),
  };
  const options = {
    root,
    cloud: join(folder, 'cloud'),
    supported: true,
    prepareTools: vi.fn(async () => {}),
    savePassword: vi.fn(async (_password: string) => {}),
    createService: vi.fn(() => new BackupService({ root, driver })),
  };
  return { root, options, capture, setup: new BackupSetup(options) };
}
it('prepares host-owned storage without credentials or captures and configures immediately', async () => {
  const { setup, options, capture, root } = await fixture();
  expect((await setup.status()).prepared).toBe(false);
  await setup.prepare();
  expect(options.savePassword).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  expect((await setup.overview()).ready).toBe(false);
  await setup.configure({ password: 'synthetic-recovery-password', recoveryConfirmed: true });
  expect(options.savePassword).toHaveBeenCalledWith('synthetic-recovery-password');
  expect((await setup.overview()).ready).toBe(true);
  expect(await readFile(join(root, 'setup.json'), 'utf8')).not.toContain(
    'synthetic-recovery-password',
  );
  expect((await new BackupSetup(options).overview()).ready).toBe(true);
  expect(capture).not.toHaveBeenCalled();
});
it('requires preparation and recovery confirmation before storing a password', async () => {
  const { setup, options } = await fixture();
  await expect(
    setup.configure({ password: 'synthetic-recovery-password', recoveryConfirmed: true }),
  ).rejects.toThrow();
  await setup.prepare();
  for (const password of ['', 'short', 'synthetic-secret\nline']) {
    await expect(setup.configure({ password, recoveryConfirmed: true })).rejects.toThrow();
  }
  await expect(
    setup.configure({ password: 'synthetic-recovery-password', recoveryConfirmed: false }),
  ).rejects.toThrow();
  expect(options.savePassword).not.toHaveBeenCalled();
});
it('keeps failed setup disabled, sanitizes errors, and allows an explicit retry', async () => {
  const { setup, options } = await fixture();
  await setup.prepare();
  options.savePassword.mockRejectedValueOnce(Error('SECRET /private/path'));
  await expect(
    setup.configure({ password: 'synthetic-recovery-password', recoveryConfirmed: true }),
  ).rejects.toThrow('Backup password could not be saved. Unlock Keychain on the Mac and retry.');
  expect((await setup.overview()).ready).toBe(false);
  await setup.configure({ password: 'synthetic-recovery-password', recoveryConfirmed: true });
  expect((await setup.overview()).ready).toBe(true);
});
it('never rotates a configured repository password or removes a retained writer fence', async () => {
  const { setup, options, root } = await fixture();
  await setup.prepare();
  await mkdir(join(root, 'writer.lock'));
  await expect(
    setup.configure({ password: 'synthetic-recovery-password', recoveryConfirmed: true }),
  ).rejects.toThrow();
  expect(options.savePassword).not.toHaveBeenCalled();
  await rm(join(root, 'writer.lock'), { recursive: true });
  await setup.configure({ password: 'synthetic-recovery-password', recoveryConfirmed: true });
  await expect(
    setup.configure({ password: 'different-recovery-password', recoveryConfirmed: true }),
  ).rejects.toThrow();
  expect(options.savePassword).toHaveBeenCalledTimes(1);
});
it('rejects shared storage and unsupported hosts without repairing them', async () => {
  const { setup, root, options } = await fixture();
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o755);
  await expect(setup.prepare()).rejects.toThrow();
  expect(options.prepareTools).not.toHaveBeenCalled();
  await expect(new BackupSetup({ ...options, supported: false }).prepare()).rejects.toThrow();
});
