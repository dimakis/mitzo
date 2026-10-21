import { expect, vi } from 'vitest';
import type { SessionRuntimeBindingV2 } from '@mitzo/protocol';
import { conversationJoiningRecovery } from '../lib/conversation-joining-recovery';
import { getChatDraft } from '../lib/chat-drafts';
import { ordinaryRuntimeInventoryFixture } from './ordinary-runtime-inventory-fixture';
import { joiningSetupFixture } from '../preview/conversation-joining-fixture';
import type { ConversationJoiningReviewRequest } from '../lib/conversation-joining-review';

const group = '00000000-0000-4000-8000-000000000010';
/** Recording HTTP boundary only. No real repository, account or model is called. */
export function joiningTargetHarness(
  runOn: 'local' | 'openshell' = 'local',
  controls: { retainReview?: boolean } = {},
) {
  const inventory = ordinaryRuntimeInventoryFixture();
  const profile = inventory.agentProfiles[0];
  const request: ConversationJoiningReviewRequest = {
    requestId: '00000000-0000-4000-8000-000000000020',
    joiningBrief: 'Exact original joining brief.',
    setup: {
      ...joiningSetupFixture(),
      runOn,
      artifacts: [],
      messageIds: [],
      selection: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
      agent: { profileId: profile.profileId, revision: profile.revision },
    },
  };
  const journal = conversationJoiningRecovery('source-chat');
  if (controls.retainReview !== false)
    journal.save(
      {
        version: 2,
        sourceConversationId: 'source-chat',
        reviewRequest: structuredClone(request),
        application: { state: 'capture_pending', collaborationId: group },
      },
      null,
    );
  const resources = new Map<
    string,
    {
      id: string;
      repository: string;
      baseBranch: string;
      baseOid: string;
      featureBranch: string;
      state: 'preview' | 'ready' | 'preparing' | 'claimed' | 'failed' | 'discarded';
      ordinaryRuntime?: SessionRuntimeBindingV2;
    }
  >();
  let loss: 'preview-before' | 'preview-after' | 'prepare-before' | 'prepare-after' | undefined;
  let current = true;
  let callback: ((path: string) => void | Promise<void>) | undefined;
  let duplicates = false;
  let extra:
    | ((path: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>)
    | undefined;
  const runtime: SessionRuntimeBindingV2 = {
    version: 2,
    account: inventory.accounts[0].account,
    harness: { implementation: 'codex' },
    execution: {
      location: runOn,
      targetId: runOn === 'local' ? 'mac' : 'sandbox',
      targetRevision: runOn === 'local' ? 'target-r1' : 'sandbox-r1',
    },
  };
  const transport = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'https://offline.invalid');
    if (url.pathname === '/api/auth/check')
      return Response.json({ ok: true, authSessionId: 'target-owner-login' });
    expect(init?.credentials).toBe('include');
    await callback?.(url.pathname);
    const additional = await extra?.(url.pathname, init);
    if (additional) return additional;
    if (url.pathname === '/api/chat/runtime/capabilities') return Response.json(inventory);
    if (url.pathname === '/api/repository-workspaces/catalog')
      return Response.json({
        available: true,
        repositories: [
          { connectionId: 'github-one', label: 'Repository account', repository: 'dimakis/mitzo' },
          ...(duplicates
            ? [{ connectionId: 'github-two', label: 'Other account', repository: 'dimakis/mitzo' }]
            : []),
        ],
      });
    const match = url.pathname.match(/^\/api\/repository-workspaces\/([^/]+)(\/prepare)?$/);
    if (url.pathname === '/api/repository-workspaces/preview') {
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init!.body as string);
      const retained = journal.readTarget()!;
      expect(retained.phase).toBe('preview_pending');
      expect(body).toEqual(retained.preview);
      expect(getChatDraft(retained.draft.id)?.settings).toEqual(retained.draft.settings);
      if (loss === 'preview-before') {
        loss = undefined;
        throw Error('No response');
      }
      resources.set(body.requestId, {
        id: body.requestId,
        repository: body.repository,
        baseBranch: 'main',
        baseOid: 'f'.repeat(40),
        featureBranch: `mitzo/repo-${body.requestId}`,
        state: 'preview',
      });
      if (loss === 'preview-after') {
        loss = undefined;
        throw Error('Response lost');
      }
      return Response.json(resources.get(body.requestId));
    }
    expect(match).not.toBeNull();
    const resource = resources.get(match![1]);
    if (!match![2])
      return resource
        ? Response.json(resource)
        : Response.json({ error: 'Unavailable' }, { status: 404 });
    expect(init?.method).toBe('POST');
    const retained = journal.readTarget()!;
    expect(retained.phase).toBe('prepare_pending');
    expect(retained.preview.requestId).toBe(match![1]);
    expect(JSON.parse(init!.body as string)).toEqual({
      accountId: 'personal',
      model: 'luna-fixture',
    });
    if (loss === 'prepare-before') {
      loss = undefined;
      throw Error('Prepare response unknown');
    }
    if (!resource) throw Error('Missing resource');
    resource.state = 'ready';
    resource.ordinaryRuntime = structuredClone(runtime);
    if (loss === 'prepare-after') {
      loss = undefined;
      throw Error('Committed response lost');
    }
    return Response.json(resource);
  });
  vi.stubGlobal('fetch', transport);
  const options = {
    sourceConversationId: 'source-chat',
    collaborationId: group,
    repository: 'dimakis/mitzo' as string | null,
    request,
    signal: new AbortController().signal,
    isCurrent: () => current,
  };
  return {
    options,
    request,
    journal,
    transport,
    inventory,
    resources,
    runtime,
    extra: (value: typeof extra) => {
      extra = value;
    },
    lose: (value: typeof loss) => {
      loss = value;
    },
    retire: () => {
      current = false;
    },
    resume: () => {
      current = true;
    },
    after: (value: typeof callback) => {
      callback = value;
    },
    ambiguousConnections: () => {
      duplicates = true;
    },
    posts: () => transport.mock.calls.filter(([, init]) => init?.method === 'POST'),
  };
}
