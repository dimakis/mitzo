import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import type { createPublicationRouter } from '../symposium-publication-routes.js';
import type { createSymposiumCustodianService } from '../symposium-custodian-service.js';
const captured = vi.hoisted(() => ({
  routes: [] as Parameters<typeof createPublicationRouter>[0][],
}));
vi.mock('../symposium-publication-routes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../symposium-publication-routes.js')>();
  return {
    ...actual,
    createPublicationRouter: (deps: Parameters<typeof createPublicationRouter>[0]) => {
      captured.routes.push(deps);
      return actual.createPublicationRouter(deps);
    },
  };
});
const roots: string[] = [];
const owners: ReturnType<typeof createSymposiumCustodianService>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.closeUninstalledService();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  captured.routes.splice(0);
  vi.unstubAllEnvs();
});
async function compose(native: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-publication-composition-')));
  roots.push(root);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', native ? '1' : '0');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private-codex'));
  const approval = vi.fn();
  const { createSymposiumCustodianService } = await import('../symposium-custodian-service.js');
  owners.push(
    createSymposiumCustodianService({ workspaceRoot: root, publicationApproval: approval }),
  );
  return { approval, route: captured.routes.at(-1)! };
}
it('preserves the accepted standalone ordinary controller approval port without importing its registry into the native service', async () => {
  const { approval, route } = await compose(false);
  const request = { header: () => 'actual-connection' } as unknown as Request;
  const session = { id: 'actual-operator', expiresAt: Date.now() + 30000 };
  route.approval(request, session, 'actual-conversation');
  expect(approval).toHaveBeenCalledExactlyOnceWith(request, session, 'actual-conversation');
});
it('never invokes the ordinary approval port for native requests missing their opaque original IPC approval', async () => {
  const { approval, route } = await compose(true);
  expect(
    route.approval({} as Request, { id: 'operator', expiresAt: Date.now() + 30000 }, 'session'),
  ).toBeUndefined();
  expect(approval).not.toHaveBeenCalled();
});
