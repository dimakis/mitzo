import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  review: vi.fn(),
  factory: vi.fn(),
  executorDependencies: undefined as unknown,
}));
vi.mock('../ordinary-publication-review.js', () => ({
  createOrdinaryPublicationReview: mocks.factory.mockImplementation(() => mocks.review),
}));
vi.mock('../connections/capabilities/github-publish-pr.js', async (original) => {
  const actual =
    await original<typeof import('../connections/capabilities/github-publish-pr.js')>();
  return {
    ...actual,
    createGithubArtifactPublishPrExecutor: (
      deps: Parameters<typeof actual.createGithubArtifactPublishPrExecutor>[0],
    ) => {
      mocks.executorDependencies = deps;
      return actual.createGithubArtifactPublishPrExecutor(deps);
    },
  };
});
import { createConnectionsRuntime } from '../connections-runtime.js';

it('installs the authenticated independent review owner in the ordinary production publisher', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-publication-composition-'));
  const runtime = createConnectionsRuntime({
    directory,
    cli: '/unavailable-offline-openshell',
    workspace: 'offline',
    eligibleAccountIds: () => [],
    githubPublishEnabled: true,
  });
  try {
    expect(mocks.factory).toHaveBeenCalledOnce();
    expect(mocks.factory.mock.calls[0][0]).toMatchObject({ resolveOwner: expect.any(Function) });
    expect(mocks.executorDependencies).toMatchObject({ reviewCommittedChange: mocks.review });
  } finally {
    runtime.store.close();
    runtime.capabilityStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
