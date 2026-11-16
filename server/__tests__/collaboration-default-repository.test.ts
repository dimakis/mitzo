import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApplicationReviewInputSchema } from '@mitzo/protocol';
import {
  fixture,
  cleanupApplicationReviewFixtures,
} from './fixtures/collaboration-application-review.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
afterEach(cleanupApplicationReviewFixtures);

it('reviews the ordinary default without a repository choice and retains that exact preparation on retry and brief edits', async () => {
  const f = await fixture({ defaultRepository: true });
  const select = vi.spyOn(f.workspaces, 'selectLocalRepository');
  const { repositoryWorkspaceId: explicit, ...target } = f.input.target;
  const input = { ...f.input, target: { ...target, useDefaultRepository: true } };
  const sessions = f.store.listSessions();
  const first = await f.review(input);
  expect(first.settings.repositoryWorkspaceId).not.toBe(explicit);
  const workspace = f.workspaces.get(first.settings.repositoryWorkspaceId);
  expect(workspace.repository).toBe('local/primary');
  expect(workspace.localSource?.repositoryId).toBe('primary');
  expect(workspace.state).toBe('ready');
  expect(workspace.conversationId).toBeUndefined();
  expect(f.store.listSessions()).toEqual(sessions);
  expect(await f.review(input)).toEqual(first);
  expect(select).toHaveBeenCalledTimes(1);
  const edited = await f.review({
    ...input,
    selection: { ...input.selection, requestId: randomUUID(), joiningBrief: 'Edited brief' },
    previousSnapshot: { snapshotId: first.snapshot.snapshotId, sha256: first.snapshot.sha256 },
  });
  expect(edited.settings).toEqual(first.settings);
  expect(edited.snapshot.joiningBrief).toBe('Edited brief');
  expect(select).toHaveBeenCalledTimes(1);
  expect(f.store.listSessions()).toEqual(sessions);
});

it('does not treat a missing, conflicting or invalid repository selector as a default choice', async () => {
  const f = await fixture();
  const target = { ...f.input.target, repositoryWorkspaceId: undefined };
  expect(CollaborationApplicationReviewInputSchema.safeParse({ ...f.input, target }).success).toBe(
    false,
  );
  expect(
    CollaborationApplicationReviewInputSchema.safeParse({
      ...f.input,
      target: { ...f.input.target, useDefaultRepository: true },
    }).success,
  ).toBe(false);
  const select = vi.spyOn(f.workspaces, 'selectLocalRepository');
  await expect(
    f.review({ ...f.input, target: { ...f.input.target, repositoryWorkspaceId: 'missing' } }),
  ).rejects.toThrow();
  expect(select).not.toHaveBeenCalled();
});

it('keeps a missing default unavailable without borrowing the source or explicit workspace', async () => {
  const f = await fixture();
  const target = { ...f.input.target, repositoryWorkspaceId: undefined };
  const sessions = f.store.listSessions();
  await expect(
    f.review({ ...f.input, target: { ...target, useDefaultRepository: true } }),
  ).rejects.toThrow();
  expect(f.store.listSessions()).toEqual(sessions);
  expect(
    f.store.collaborationConversation.getReviewCompilation(f.group, f.input.selection.requestId),
  ).toBeNull();
});

it('rejects an unsupported default environment before repository selection', async () => {
  const f = await fixture({ defaultRepository: true });
  const select = vi.spyOn(f.workspaces, 'selectLocalRepository');
  const target = { ...f.input.target, repositoryWorkspaceId: undefined };
  await expect(
    f.review({ ...f.input, target: { ...target, runOn: 'openshell', useDefaultRepository: true } }),
  ).rejects.toThrow();
  expect(select).not.toHaveBeenCalled();
});
