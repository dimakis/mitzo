import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeychainController } from '../keychain-controller.js';
it('creates a private controller capability and records only enrolled pinned references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mitzo-controller-'));
  try {
    const controller = new KeychainController(directory);
    await controller.initialize();
    const token = await controller.authorization();
    expect(token.length).toBe(64);
    expect((await stat(join(directory, 'controller.json'))).mode & 0o777).toBe(0o600);
    const ref = { service: 'service', account: 'account', persistentRef: 'aXRlbS1pZA==' };
    await controller.enroll(ref);
    const record = JSON.parse(await readFile(join(directory, 'controller.json'), 'utf8'));
    expect(record.items).toEqual([ref]);
    await controller.forget(ref);
    expect(JSON.parse(await readFile(join(directory, 'controller.json'), 'utf8')).items).toEqual(
      [],
    );
    await chmod(join(directory, 'controller.json'), 0o644);
    await expect(controller.authorization()).rejects.toThrow('private');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('serializes first initialization and updates across controllers for the same directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mitzo-controller-'));
  try {
    const controllers = Array.from({ length: 20 }, () => new KeychainController(directory));
    const tokens = await Promise.all(controllers.map((controller) => controller.authorization()));
    expect(new Set(tokens).size).toBe(1);
    await Promise.all(
      controllers.map((controller, index) =>
        controller.enroll({
          service: `service-${index}`,
          account: 'account',
          persistentRef: Buffer.from(`item-${index}`).toString('base64'),
        }),
      ),
    );
    const record = JSON.parse(await readFile(join(directory, 'controller.json'), 'utf8'));
    expect(record.items).toHaveLength(controllers.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects malformed controller records and enrollments without exposing their contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mitzo-controller-'));
  try {
    const controller = new KeychainController(directory);
    await controller.initialize();
    await expect(
      controller.enroll({ service: '', account: 'account', persistentRef: 'secret!' }),
    ).rejects.toThrow(/^Invalid Keychain reference$/);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, 'controller.json'), 'private-secret', { mode: 0o600 });
    await expect(controller.authorization()).rejects.toThrow(
      /^Invalid Keychain controller record$/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('isolates controller capabilities and enrolled items between namespaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mitzo-controller-'));
  try {
    const production = new KeychainController(join(directory, 'production'), 'production');
    const staging = new KeychainController(join(directory, 'staging'), 'staging');
    expect(production.namespace).toBe('production');
    expect(staging.namespace).toBe('staging');
    expect(await production.authorization()).not.toBe(await staging.authorization());
    await production.enroll({
      service: 'service',
      account: 'account',
      persistentRef: 'aXRlbS1pZA==',
    });
    expect(
      JSON.parse(await readFile(join(directory, 'staging', 'controller.json'), 'utf8')).items,
    ).toEqual([]);
    expect(() => new KeychainController(directory, '../escape')).toThrow('namespace');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
