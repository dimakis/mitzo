import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const composition = vi.hoisted(() => ({
  create: vi.fn(() => ({
    reviewHost: { currentArtifact: vi.fn() },
    assertReaderAdmissionCurrent: vi.fn(() => true),
    assertReaderAdmissionStaged: vi.fn(() => true),
    close: vi.fn(),
  })),
}));
vi.mock('../symposium-production-review-composition.js', () => ({
  createSymposiumProductionReviewComposition: composition.create,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('installs the concrete trusted review owner only in the retained custodian', async () => {
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', '1');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'symposium-review-install-')));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private-codex'));
  const { createSymposiumCustodianService } = await import('../symposium-custodian-service.js');
  const service = createSymposiumCustodianService({ workspaceRoot: root });
  const host = {
    sourceImport: { requireSeal: vi.fn(), initialExport: vi.fn() },
  } as never;
  service.installSymposiumProductionHost(host);
  expect(composition.create).toHaveBeenCalledOnce();
  expect((host as { reviewHost?: unknown }).reviewHost).toBe(
    composition.create.mock.results[0].value.reviewHost,
  );
  service.getSymposiumBootstrapDependencies().facts.close();
  service.getSymposiumBootstrapDependencies().reviews.close();
  rmSync(root, { recursive: true, force: true });
});
