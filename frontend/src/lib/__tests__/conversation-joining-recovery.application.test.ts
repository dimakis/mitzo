// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { conversationJoiningRecovery } from '../conversation-joining-recovery';
import { markAuthLost, restoreCookieAuthentication } from '../api-fetch';
import { joiningSetupFixture } from '../../preview/conversation-joining-fixture';

beforeEach(async () => {
  sessionStorage.clear();
  localStorage.clear();
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'application-record' })),
  );
  await restoreCookieAuthentication();
});
afterEach(() => vi.unstubAllGlobals());
function record() {
  const setup = joiningSetupFixture();
  const requestId = '00000000-0000-4000-8000-000000000020';
  return {
    version: 2 as const,
    sourceConversationId: 'source-chat',
    reviewRequest: { requestId, setup, joiningBrief: 'Exact edited brief' },
    application: {
      state: 'captured' as const,
      collaborationId: '00000000-0000-4000-8000-000000000001',
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
          joiningBrief: 'Exact edited brief',
        },
        target: {
          runOn: setup.runOn,
          accountId: setup.selection!.accountId!,
          model: setup.selection!.model,
          reasoningEffort: null,
          agent: setup.agent,
          permissionMode: 'ask' as const,
          repositoryWorkspaceId: 'unused-selected-workspace',
        },
      },
    },
  };
}
it('retains exact public application input without changing its strings, array order or omitted fields', () => {
  const storage = conversationJoiningRecovery('source-chat');
  const input = record();
  const saved = storage.save(input, null);
  input.application.input.selection.joiningBrief = 'Mutated callback';
  expect(storage.read()).toEqual(saved);
  expect(saved).toEqual(record());
  expect(JSON.stringify(saved)).not.toMatch(/clientId|native|capacity|operator|credential/);
});

it.each(['canonical', 'historical'] as const)(
  'retains %s full-conversation wire without clearing saved Selected choices or rewriting replay',
  (kind) => {
    const storage = conversationJoiningRecovery('source-chat');
    const input = record();
    input.reviewRequest.setup.context = 'conversation_so_far';
    input.application.input.selection.mode = 'conversation_so_far';
    if (kind === 'canonical') input.application.input.selection.messageIds = [];
    const original = structuredClone(input);
    const saved = storage.save(input, null);
    expect(storage.read()).toEqual(original);
    expect(storage.read()!.reviewRequest.setup.messageIds).toEqual(['message-one']);
    expect(saved).toEqual(original);
    expect(storage.save(structuredClone(original), saved)).toEqual(original);
  },
);

it('rejects a substituted nonempty full-conversation ID list that is not its exact retained legacy wire', () => {
  const storage = conversationJoiningRecovery('source-chat');
  const input = record();
  input.reviewRequest.setup.context = 'conversation_so_far';
  input.application.input.selection.mode = 'conversation_so_far';
  input.application.input.selection.messageIds = ['other'];
  expect(() => storage.save(input, null)).toThrow('Captured application review identity conflicts');
  expect(storage.read()).toBeNull();
});
it.each([
  'request',
  'source',
  'mode',
  'purpose',
  'messages',
  'artifacts',
  'account',
  'model',
  'reasoning',
  'runOn',
  'agent',
  'brief',
  'previous',
] as const)('refuses captured application %s conflicts with retained review intent', (field) => {
  const storage = conversationJoiningRecovery('source-chat'),
    input = record();
  const s = input.application.input.selection,
    t = input.application.input.target;
  if (field === 'request') s.requestId = '00000000-0000-4000-8000-000000000021';
  if (field === 'source') s.sourceConversationId = 'other';
  if (field === 'mode') s.mode = 'conversation_so_far';
  if (field === 'purpose') s.purpose = 'Other purpose';
  if (field === 'messages') s.messageIds = [];
  if (field === 'artifacts') s.artifacts = [];
  if (field === 'account') t.accountId = 'other';
  if (field === 'model') t.model = 'other';
  if (field === 'reasoning') Object.assign(t, { reasoningEffort: 'high' });
  if (field === 'runOn') t.runOn = 'openshell';
  if (field === 'agent') t.agent = { ...t.agent!, revision: 2 };
  if (field === 'brief') s.joiningBrief = 'Other';
  if (field === 'previous')
    Object.assign(input.application.input, {
      previousSnapshot: {
        snapshotId: '00000000-0000-4000-8000-000000000022',
        sha256: 'c'.repeat(64),
      },
    });
  expect(() => storage.save(input, null)).toThrow('Captured application review identity conflicts');
  expect(storage.read()).toBeNull();
});
it.each(['group', 'input', 'downgrade', 'pending'] as const)(
  'refuses same-request captured %s replacement while accepting equivalent object keys',
  (field) => {
    const storage = conversationJoiningRecovery('source-chat');
    const saved = storage.save(record(), null);
    const equivalent = {
      ...record(),
      application: {
        ...record().application,
        input: {
          target: record().application.input.target,
          selection: record().application.input.selection,
        },
      },
    };
    const same = storage.save(equivalent, saved);
    const changed = structuredClone(equivalent);
    if (field === 'group')
      changed.application.collaborationId = '00000000-0000-4000-8000-000000000002';
    if (field === 'input') changed.application.input.selection.boundary.sequence++;
    const raw =
      field === 'pending'
        ? {
            ...changed,
            application: {
              state: 'capture_pending',
              collaborationId: changed.application.collaborationId,
            },
          }
        : field === 'downgrade'
          ? {
              version: 1,
              sourceConversationId: changed.sourceConversationId,
              reviewRequest: changed.reviewRequest,
            }
          : changed;
    expect(() => storage.save(raw, same)).toThrow('Original application review must be recovered');
    expect(storage.read()).toEqual(saved);
  },
);
