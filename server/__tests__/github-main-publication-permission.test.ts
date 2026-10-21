import { afterEach, expect, it } from 'vitest';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { approveGithubMainPublication } from '../github-main-publication-permission.js';
import type { MainPublicationPermission } from '../telos-main-publication.js';

const registries: SessionRegistry[] = [];
afterEach(() => registries.splice(0).forEach((r) => r.dispose()));
/** Component test of the genuine permission owner/registry, with synthetic UI
 * responses. This does not claim native installation, account/runtime admission
 * or main-publication app acceptance. */
function fixture() {
  const registry = new SessionRegistry();
  registries.push(registry);
  const sent: Record<string, unknown>[] = [];
  registry.register('client', {
    sessionId: 'conversation',
    transport: {
      isOpen: () => true,
      send: (event) => {
        sent.push(event);
      },
    },
    abortController: new AbortController(),
    sessionAllowList: new Set(['RequestGithubMainPublication']),
    mode: 'agent',
  });
  const presentation: MainPublicationPermission = {
    toolName: 'RequestGithubMainPublication',
    pins: {
      contract: 'normal-pr-rules-v1',
      input: {
        requestId: 'publication',
        itemId: 'item',
        pullRequest: 9,
        sourceHead: 'a'.repeat(40),
        workRevision: 'exact-work',
      },
      authority: {
        operatorId: 'operator',
        conversationId: 'conversation',
        accountBinding: {
          accountId: 'account',
          provider: 'openai-codex',
          model: 'offline-fixture',
          profileRevision: 'profile-1',
        },
        runtimeId: 'runtime',
        connectionId: 'connection',
        capabilityId: 'configured-main',
        repository: 'owner/project',
        assignmentRevision: 3,
        attemptId: null,
      },
      resource: {
        repositoryId: 101,
        repositoryNodeId: 'R_original',
        pullRequestId: 901,
        pullRequestNodeId: 'PR_original',
      },
      baseBranch: 'main',
      method: 'squash',
    },
  };
  return { registry, sent, presentation, signal: new AbortController().signal };
}

it('forces the existing exact-pin request dialog even with a preexisting tool grant, and consumes one approval once', async () => {
  const f = fixture();
  const invocation = approveGithubMainPublication(
    f.registry,
    'client',
    f.presentation,
    f.signal,
    () => {},
  );
  await Promise.resolve();
  const request = f.sent.find((e) => e.type === 'permission_request')!;
  expect(request).toMatchObject({
    toolName: 'RequestGithubMainPublication',
    approvalScope: 'request',
  });
  for (const pin of ['owner/project', '#9', 'a'.repeat(40), 'exact-work'])
    expect(request.description).toContain(pin);
  expect(request.description).toContain('Main may advance');
  expect(request.description).toContain('no fixed main revision');
  expect(request.description).not.toContain('b'.repeat(40));
  expect(resolvePending(request.permId as string, 'once', undefined, 'conversation')).toBe(true);
  expect(await invocation).toMatchObject({ receiptId: expect.any(String) });
  expect(resolvePending(request.permId as string, 'once', undefined, 'conversation')).toBe(false);
  const next = approveGithubMainPublication(
    f.registry,
    'client',
    f.presentation,
    f.signal,
    () => {},
  );
  await Promise.resolve();
  const second = f.sent.filter((e) => e.type === 'permission_request').at(-1)!;
  expect(second.permId).not.toBe(request.permId);
  resolvePending(second.permId as string, 'deny', undefined, 'conversation');
  expect(await next).toBeUndefined();
});
it('does not store a broad grant even if a UI returns always', async () => {
  const f = fixture();
  f.registry.get('client')!.sessionAllowList.clear();
  const invocation = approveGithubMainPublication(
    f.registry,
    'client',
    f.presentation,
    f.signal,
    () => {},
  );
  await Promise.resolve();
  const request = f.sent.find((e) => e.type === 'permission_request')!;
  resolvePending(request.permId as string, 'always', undefined, 'conversation');
  expect(await invocation).toBeDefined();
  expect(f.registry.get('client')!.sessionAllowList.size).toBe(0);
});
it('refuses a different conversation before displaying approval', async () => {
  const f = fixture();
  f.presentation.pins.authority.conversationId = 'other';
  expect(
    await approveGithubMainPublication(f.registry, 'client', f.presentation, f.signal, () => {}),
  ).toBeUndefined();
  expect(f.sent).toHaveLength(0);
});
it('rechecks the host authority after the real permission response', async () => {
  const f = fixture();
  let revoked = false;
  const invocation = approveGithubMainPublication(
    f.registry,
    'client',
    f.presentation,
    f.signal,
    () => {
      if (revoked) throw new Error('Operator revoked');
    },
  );
  await Promise.resolve();
  const request = f.sent.find((e) => e.type === 'permission_request')!;
  revoked = true;
  resolvePending(request.permId as string, 'once', undefined, 'conversation');
  await expect(invocation).rejects.toThrow('Operator revoked');
});
