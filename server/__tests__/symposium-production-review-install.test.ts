import { afterEach, expect, it, vi } from 'vitest';

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
  const app = await import('../app.js');
  const host = {
    sourceImport: { requireSeal: vi.fn(), initialExport: vi.fn() },
  } as never;
  app.installSymposiumProductionHost(host);
  expect(composition.create).toHaveBeenCalledOnce();
  expect((host as { reviewHost?: unknown }).reviewHost).toBe(
    composition.create.mock.results[0].value.reviewHost,
  );
});
