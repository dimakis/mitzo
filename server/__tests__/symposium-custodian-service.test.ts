import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CustodianRequest } from '../symposium-custodian-protocol.js';
import type { createSymposiumCustodianService } from '../symposium-custodian-service.js';

const directories: string[] = [];
const services: ReturnType<typeof createSymposiumCustodianService>[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.closeUninstalledService();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-native-service-')));
  directories.push(root);
  return root;
}
function command(
  operation: CustodianRequest['operation'],
  body: Record<string, unknown> = {},
): CustodianRequest {
  return {
    epoch: 1,
    requestId: 'original-semantic-request',
    operation,
    body,
    query: {},
    authorization: { id: 'actual-controller-operator', expiresAt: Date.now() + 30_000 },
  };
}
async function service() {
  const workspaceRoot = directory();
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', '1');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(workspaceRoot, 'private-codex'));
  const module = await import('../symposium-custodian-service.js');
  const owner = module.createSymposiumCustodianService({ workspaceRoot });
  services.push(owner);
  return owner;
}

it('imports its actual semantic composition without opening stores, reading auth, or creating paths', async () => {
  const root = directory();
  vi.stubEnv('REPO_PATH', join(root, 'not-created-workspace'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'not-created-codex'));
  vi.stubEnv('AUTH_PASSPHRASE', '');
  vi.stubEnv('AUTH_SECRET', '');
  const module = await import('../symposium-custodian-service.js');
  expect(module.SYMPOSIUM_CUSTODIAN_SERVICE_PROTOCOL_VERSION).toBe(1);
  expect(module.createSymposiumCustodianService).toBeTypeOf('function');
  expect(existsSync(process.env.REPO_PATH!)).toBe(false);
  expect(existsSync(process.env.MITZO_CODEX_PRIVATE_DIR!)).toBe(false);
});
it('refuses relative, aliased, and missing original workspaces before creating state', async () => {
  const root = directory();
  const module = await import('../symposium-custodian-service.js');
  expect(() => module.createSymposiumCustodianService({ workspaceRoot: '.' })).toThrow('absolute');
  expect(() =>
    module.createSymposiumCustodianService({ workspaceRoot: join(root, 'missing') }),
  ).toThrow();
  const owned = join(root, 'owned');
  mkdirSync(owned, { mode: 0o700 });
  symlinkSync(owned, join(root, 'alias'));
  expect(() =>
    module.createSymposiumCustodianService({ workspaceRoot: join(root, 'alias') }),
  ).toThrow('absolute');
  expect(existsSync(join(owned, '.mitzo'))).toBe(false);
});
it('dispatches actual profile/library stores through the original finite semantic router', async () => {
  const owner = await service();
  const current = vi.fn();
  const saved = await owner.dispatchCustodianRequest(
    command('profile.create', {
      profileId: 'reviewer',
      expectedRevision: 0,
      idempotencyKey: 'create',
      definition: {
        name: 'Reviewer',
        role: 'reviewer',
        instructions: 'Review code',
        expectedOutput: 'Findings',
        acceptanceCriteria: ['Evidence'],
        modelPolicyRole: 'reviewer',
      },
    }),
    current,
  );
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ profileId: 'reviewer', revision: 1 });
  const listed = await owner.dispatchCustodianRequest(command('profile.list'), current);
  expect(listed).toEqual({ status: 200, body: [saved.body] });
  expect((await owner.dispatchCustodianRequest(command('library.list'), current)).status).toBe(200);
  expect(current.mock.calls.length).toBeGreaterThan(3);
});
it('keeps account/enrollment/model dispatch unavailable without the actual installed native host', async () => {
  const owner = await service();
  expect((await owner.dispatchCustodianRequest(command('account.catalog'), () => {})).status).toBe(
    503,
  );
  expect(
    (await owner.dispatchCustodianRequest(command('feature.resources'), () => {})).status,
  ).toBe(503);
  expect(
    (
      await owner.dispatchCustodianRequest(
        { ...command('feature.enrollment'), resourceId: 'work' },
        () => {},
      )
    ).status,
  ).toBe(503);
  expect(owner.currentHost()).toBeUndefined();
});
it('refuses unknown sessions and lost original controller authority before semantic execution', async () => {
  const owner = await service();
  expect(() =>
    owner.dispatchCustodianRequest(
      { ...command('director.status'), sessionId: 'reopened-session' },
      () => {},
    ),
  ).toThrow('original retained custodian');
  expect(() =>
    owner.dispatchCustodianRequest(command('profile.list'), () => {
      throw Error('original queue lost');
    }),
  ).toThrow('original queue lost');
});
