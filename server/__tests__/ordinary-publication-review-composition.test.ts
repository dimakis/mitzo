import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executorDependencies: undefined as unknown,
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

it('publishes ordinary PRs without constructing a model reviewer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-publication-composition-'));
  const runtime = createConnectionsRuntime({
    directory,
    cli: '/unavailable-offline-openshell',
    workspace: 'offline',
    eligibleAccountIds: () => [],
    githubPublishEnabled: true,
  });
  try {
    expect(mocks.executorDependencies).not.toHaveProperty('reviewCommittedChange');
  } finally {
    runtime.store.close();
    runtime.capabilityStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
