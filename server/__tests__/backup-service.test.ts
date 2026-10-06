import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { ResticRepository } from '../backup/restic.js';
import { ICloudBackupTransport } from '../backup/icloud-transport.js';
import { BackupService } from '../backup/service.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'backup-service-'));
  roots.push(root);
  const generation = {
    id: 'a909435d-e134-4ee7-ab39-10bf6f553634',
    createdAt: new Date().toISOString(),
    status: 'pending' as const,
    bytes: 1024,
    objects: 3,
  };
  const driver = {
    capture: vi.fn(async (path: string) => {
      await mkdir(path);
    }),
    initialize: vi.fn(async () => {}),
    backup: vi.fn(async () => 'a'.repeat(64)),
    check: vi.fn(async () => {}),
    publish: vi.fn(async () => generation),
    refresh: vi.fn(async () => ({ ...generation, status: 'uploaded' as const })),
  };
  const service = new BackupService({ root, driver });
  return { root, driver, service };
}
it('persists distinct local capture and cloud confirmation; refresh never recaptures', async () => {
  const { root, service, driver } = await fixture();
  await service.start();
  await service.idle();
  let view = await new BackupService({ root, driver }).overview();
  expect(view.runs[0].status).toBe('pending');
  expect(view.runs[0].snapshot).toBe('a'.repeat(64));
  expect(view.lastCloudUpload).toBeNull();
  await service.refresh();
  await service.idle();
  view = await service.overview();
  expect(view.runs[0].status).toBe('uploaded');
  expect(view.lastCloudUpload).toBeTruthy();
  expect(driver.capture).toHaveBeenCalledTimes(1);
  await expect(access(join(root, 'captures', view.runs[0].id))).rejects.toThrow();
});
it('fences concurrent runs across service instances before any owner capture', async () => {
  const { root, service, driver } = await fixture();
  let finish!: () => void;
  driver.initialize.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await service.start();
  while (!finish) await new Promise((r) => setTimeout(r, 1));
  await expect(service.start()).rejects.toThrow();
  await expect(new BackupService({ root, driver }).start()).rejects.toThrow();
  expect(driver.capture).not.toHaveBeenCalled();
  finish();
  await service.idle();
});
it('sanitizes failure and discards plaintext while leaving a durable failed receipt', async () => {
  const { service, driver, root } = await fixture();
  driver.check.mockRejectedValue(Error('/private/user/secret PASSWORD'));
  await service.start();
  await service.idle();
  const view = await service.overview();
  expect(view.runs[0].status).toBe('failed');
  expect(JSON.stringify(view)).not.toMatch(/PASSWORD|private\/user/);
  expect(driver.publish).not.toHaveBeenCalled();
  await expect(access(join(root, 'captures', view.runs[0].id))).rejects.toThrow();
});
it('fails closed with a retained writer lock and reports unfinished work without restarting it', async () => {
  const { root, service, driver } = await fixture();
  await mkdir(join(root, 'writer.lock'));
  await expect(service.start()).rejects.toThrow();
  expect(driver.initialize).not.toHaveBeenCalled();
});
it('disabled service exposes setup and incomplete ecosystem coverage without writes', async () => {
  const service = new BackupService();
  const view = await service.overview();
  expect(view.ready).toBe(false);
  expect(view.coverage.some((x) => !x.supported)).toBe(true);
  await expect(service.start()).rejects.toThrow();
});
it('keeps pending backup receipts when cloud verification fails and can retry later', async () => {
  const { service, driver } = await fixture();
  await service.start();
  await service.idle();
  driver.refresh.mockRejectedValueOnce(Error('secret'));
  await service.refresh();
  await service.idle();
  const failed = await service.overview();
  expect(failed.runs[0].status).toBe('pending');
  expect(failed.runs[0].error).toBe('Upload verification unavailable. Retry verification.');
  await service.refresh();
  await service.idle();
  expect((await service.overview()).runs[0].status).toBe('uploaded');
});
it('reports an unfinished persisted run after restart and refuses automatic replay', async () => {
  const { root, service, driver } = await fixture();
  let finish!: () => void;
  driver.initialize.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await service.start();
  while (!finish) await new Promise((r) => setTimeout(r, 1));
  const restarted = new BackupService({ root, driver });
  const overview = await restarted.overview();
  expect(overview.runs[0].status).toBe('interrupted');
  expect(overview.busy).toBe(true);
  await expect(restarted.start()).rejects.toThrow();
  finish();
  await service.idle();
});

it.runIf(!!process.env.MITZO_TEST_RESTIC_BINARY)(
  'recovers a service-created encrypted export after removing the local repository',
  async () => {
    const { root } = await fixture();
    const local = join(root, 'local');
    const repository = join(local, 'repository');
    const options = {
      binary: process.env.MITZO_TEST_RESTIC_BINARY!,
      repository,
      scratch: join(local, 'temporary'),
      password: async () => 'synthetic-service-recovery',
      recoveryConfirmed: true,
    };
    const restic = new ResticRepository(options);
    const cloud = new ICloudBackupTransport(join(root, 'fake-cloud'), async () => 'pending');
    const service = new BackupService({
      root: local,
      driver: {
        capture: async (path) => {
          await mkdir(path);
          await writeFile(join(path, 'synthetic.txt'), 'synthetic recovered bytes');
        },
        initialize: () => restic.initialize(),
        backup: (path) => restic.backup(path),
        check: () => restic.check(),
        publish: () => cloud.publish(repository),
        refresh: (id) => cloud.refresh(id),
      },
    });
    await service.start();
    await service.idle();
    const run = (await service.overview()).runs[0];
    expect(run.status).toBe('pending');
    await rm(repository, { recursive: true });
    const recoveredRepo = join(root, 'recovered-repository');
    await cloud.restore(run.generation!, recoveredRepo);
    const recovered = new ResticRepository({
      ...options,
      repository: recoveredRepo,
      scratch: join(root, 'recovered-scratch'),
    });
    await recovered.restore(run.snapshot!, join(root, 'restore'));
    expect(await readFile(join(root, 'restore', 'synthetic.txt'), 'utf8')).toBe(
      'synthetic recovered bytes',
    );
  },
  60000,
);
