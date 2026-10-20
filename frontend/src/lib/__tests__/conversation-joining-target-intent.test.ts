// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { conversationJoiningRecovery } from '../conversation-joining-recovery';
import { markAuthLost, restoreCookieAuthentication } from '../api-fetch';
import { joiningSetupFixture } from '../../preview/conversation-joining-fixture';

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'target-intent-login' })),
  );
  await restoreCookieAuthentication();
});
afterEach(() => vi.unstubAllGlobals());
function record(includeIntent = true) {
  const setup = {
    ...joiningSetupFixture(),
    ...(includeIntent
      ? { repositoryWorkspaceId: 'explicit-unused-workspace', permissionMode: 'ask' as const }
      : {}),
  };
  const requestId = '00000000-0000-4000-8000-000000000020';
  return {
    version: 2 as const,
    sourceConversationId: 'source-chat',
    reviewRequest: { requestId, setup, joiningBrief: 'Exact brief' },
    application: {
      state: 'captured' as const,
      collaborationId: '00000000-0000-4000-8000-000000000010',
      input: {
        selection: {
          requestId,
          expectedMembershipRevision: 1,
          sourceConversationId: 'source-chat',
          boundary: { sequence: 7, messageId: 'message-one' },
          mode: setup.context,
          messageIds: setup.messageIds,
          artifacts: setup.artifacts,
          purpose: setup.purpose.trim(),
          joiningBrief: 'Exact brief',
        },
        target: {
          runOn: setup.runOn,
          accountId: setup.selection!.accountId!,
          model: setup.selection!.model,
          reasoningEffort: null,
          agent: setup.agent,
          repositoryWorkspaceId: 'explicit-unused-workspace',
          permissionMode: 'ask' as const,
        },
      },
    },
  };
}
it('retains explicit workspace and permission intent before capture and through captured review without inventing proof', () => {
  const storage = conversationJoiningRecovery('source-chat'),
    value = record();
  const pending = storage.save(
    {
      ...value,
      application: { state: 'capture_pending', collaborationId: value.application.collaborationId },
    },
    null,
  );
  expect(storage.read()?.reviewRequest.setup).toEqual(value.reviewRequest.setup);
  const captured = storage.save(value, pending);
  expect(storage.read()).toEqual(captured);
  expect(JSON.stringify(captured)).not.toMatch(
    /ready|capability|capacity|credential|nativeWitness/,
  );
});
it.each(['workspace', 'permission'] as const)(
  'refuses captured %s substitution against explicit retained target intent',
  (field) => {
    const storage = conversationJoiningRecovery('source-chat'),
      value = record();
    if (field === 'workspace')
      value.application.input.target.repositoryWorkspaceId = 'different-workspace';
    else Object.assign(value.application.input.target, { permissionMode: 'auto' });
    expect(() => storage.save(value, null)).toThrow(
      'Captured application review identity conflicts',
    );
    expect(storage.read()).toBeNull();
  },
);
it.each([1, 2] as const)(
  'keeps original version%s records without new target intent readable',
  (version) => {
    const storage = conversationJoiningRecovery('source-chat'),
      value = record(false);
    const legacy = {
      version: 1,
      sourceConversationId: value.sourceConversationId,
      reviewRequest: value.reviewRequest,
    };
    const saved = storage.save(version === 1 ? legacy : value, null);
    expect(storage.read()).toEqual(saved);
    expect(storage.read()?.reviewRequest.setup).not.toHaveProperty('permissionMode');
    expect(storage.read()?.reviewRequest.setup).not.toHaveProperty('repositoryWorkspaceId');
  },
);
