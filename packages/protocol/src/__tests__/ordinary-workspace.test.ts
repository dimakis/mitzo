import { expect, it } from 'vitest';
import { OrdinaryWorkspaceSettingsSchema } from '../ordinary-workspace.js';
import { CollaborationSettingsSchema } from '../collaboration-conversation.js';
const binding = {
  version: 2,
  account: { accountId: 'fixture', provider: 'openai-codex', profileRevision: 'r1' },
  harness: { implementation: 'codex' },
  execution: { location: 'local', targetId: 'fixture-local', targetRevision: 'r1' },
};
const selection = {
  version: 1,
  agent: { profileId: 'fixture-agent', revision: 1 },
  context: { source: 'none', revision: null },
  permission: { mode: 'agent', revision: 0 },
  model: 'fixture-model',
  thinking: null,
};
const ordinary = {
  version: 2,
  binding,
  selection,
  workspace: { kind: 'ordinary', preparationId: '97347432-d9fd-43d2-8fe1-d498ec843f48' },
};

it('keeps ordinary intent explicit without allowing it through legacy strict collaboration settings', () => {
  expect(OrdinaryWorkspaceSettingsSchema.parse(ordinary)).toEqual(ordinary);
  expect(CollaborationSettingsSchema.safeParse(ordinary).success).toBe(false);
  const legacy = { binding, selection, repositoryWorkspaceId: 'legacy-repository-workspace' };
  expect(CollaborationSettingsSchema.parse(legacy)).toEqual(legacy);
  expect(OrdinaryWorkspaceSettingsSchema.safeParse(legacy).success).toBe(false);
});
it('refuses caller-supplied workspace paths, repository identities and capability grants', () => {
  for (const extra of [
    { directory: '/tmp/caller-workspace' },
    { repositoryWorkspaceId: 'fake-repository' },
    { capabilities: ['git_repository'] },
    { ready: true },
  ]) {
    expect(OrdinaryWorkspaceSettingsSchema.safeParse({ ...ordinary, ...extra }).success).toBe(
      false,
    );
    expect(
      OrdinaryWorkspaceSettingsSchema.safeParse({
        ...ordinary,
        workspace: { ...ordinary.workspace, ...extra },
      }).success,
    ).toBe(false);
  }
});
it('requires an actual opaque preparation reference instead of a source, branch or filesystem path', () => {
  for (const preparationId of ['', '/tmp/source', 'owner/repo', 'main', 'a'.repeat(40)]) {
    expect(
      OrdinaryWorkspaceSettingsSchema.safeParse({
        ...ordinary,
        workspace: { kind: 'ordinary', preparationId },
      }).success,
    ).toBe(false);
  }
});
