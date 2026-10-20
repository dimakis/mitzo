import { z } from 'zod';
import {
  CollaborationApplicationReviewInputSchema,
  SessionRuntimeBindingV2Schema,
  type CollaborationApplicationReviewInput,
} from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from './api-fetch';
import { createBrowserId } from './browser-crypto';
import { createChatDraft, getChatDraft, saveChatDraft } from './chat-drafts';
import { createChatRuntimeSelection, evaluateChatRuntimeSelection } from './chat-runtime-selection';
import { runtimeRoutes, resolveRuntimeTarget, selectedRuntimeRoute } from './chat-runtime-route';
import { ExplicitLocalInventorySchema, normalizeLocalInventory } from './explicit-local-chat';
import {
  conversationJoiningRecovery,
  joiningReviewEqual as equal,
} from './conversation-joining-recovery';
import {
  ConversationJoiningTargetIntentSchema,
  ConversationJoiningTargetError,
  type ConversationJoiningTargetIntent,
} from './conversation-joining-target-intent';
import type { ConversationJoiningReviewRequest } from './conversation-joining-review';

// Same public metadata consumed by the ordinary RepositoryChatPicker. Its
// server owner still authorizes the exact account, resource and lifecycle.
const workspaceSchema = z.object({
  id: z.uuid(),
  repository: z.string(),
  baseBranch: z.string(),
  baseOid: z.string().regex(/^[a-f0-9]{40}$/),
  featureBranch: z.string(),
  state: z.enum(['preview', 'preparing', 'ready', 'claiming', 'claimed', 'failed', 'discarded']),
  conversationId: z.string().optional(),
  ordinaryRuntime: SessionRuntimeBindingV2Schema.optional(),
});
const catalogSchema = z.object({
  available: z.boolean(),
  repositories: z.array(
    z.object({
      connectionId: z.string(),
      label: z.string(),
      repository: z.string(),
    }),
  ),
});
function failure(message: string): never {
  throw new ConversationJoiningTargetError(message);
}
const originalError =
  'The original repository preparation could not be checked. Its request stays retained.';

/** Explicit Review staging through the existing ordinary owners. No source
 * workspace, active permission, session allocation, provider call or send is reused. */
export async function prepareConversationJoiningTarget(options: {
  sourceConversationId: string;
  collaborationId: string;
  repository: string | null;
  request: ConversationJoiningReviewRequest;
  signal: AbortSignal;
  isCurrent(): boolean;
}): Promise<
  Pick<CollaborationApplicationReviewInput['target'], 'repositoryWorkspaceId' | 'permissionMode'>
> {
  const { signal, sourceConversationId, collaborationId, repository, isCurrent } = options;
  const request = structuredClone(options.request);
  const journal = conversationJoiningRecovery(sourceConversationId);
  const selection = CollaborationApplicationReviewInputSchema.shape.target
    .omit({
      repositoryWorkspaceId: true,
      permissionMode: true,
    })
    .parse({
      runOn: request.setup.runOn,
      accountId: request.setup.selection?.accountId,
      model: request.setup.selection?.model,
      reasoningEffort: request.setup.selection?.reasoningEffort ?? null,
      agent: request.setup.agent,
    });
  let target = journal.readTarget();
  let retired = false;
  const retire = () => {
    retired = true;
  };
  window.addEventListener(AUTH_LOST_EVENT, retire);
  window.addEventListener(AUTH_RESTORED_EVENT, retire);
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (retired || !journal.isCurrent() || !isCurrent()) failure(originalError);
  };
  const readReview = () => {
    assertCurrent();
    const stored = journal.read();
    if (
      !stored ||
      stored.version !== 2 ||
      stored.application.state !== 'capture_pending' ||
      stored.application.collaborationId !== collaborationId ||
      stored.submission ||
      !equal(stored.reviewRequest, request)
    )
      failure(originalError);
    return stored;
  };
  const save = (next: ConversationJoiningTargetIntent) => {
    const review = readReview();
    target = journal.retainTarget(next, target, review);
    return target;
  };
  const fetch = async (path: string, body?: unknown) => {
    assertCurrent();
    readReview();
    if (!equal(journal.readTarget(), target)) failure(originalError);
    const response = await apiFetch(path, {
      signal,
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    assertCurrent();
    return response;
  };
  const json = async (response: Response) => {
    const value: unknown = await response.json();
    assertCurrent();
    return value;
  };
  const sameTarget = (value: ConversationJoiningTargetIntent) =>
    value.collaborationId === collaborationId &&
    value.preview.repository === repository &&
    value.preview.accountId === selection.accountId &&
    value.preview.model === selection.model &&
    value.preview.ordinaryRuntime.runOn === selection.runOn;
  const sourceCurrent =
    request.setup.sourceRepository === undefined || request.setup.sourceRepository === repository;
  try {
    assertCurrent();
    readReview();
    if (!selection.agent || !repository)
      failure('This chat has no verified repository for a fresh agent. Your setup stays here.');
    if (target && target.collaborationId !== collaborationId) failure(originalError);
    if (
      (request.setup.repositoryWorkspaceId !== undefined &&
        request.setup.repositoryWorkspaceId !== target?.preview.requestId) ||
      (request.setup.permissionMode !== undefined &&
        request.setup.permissionMode !== target?.draft.settings.mode)
    )
      failure('The original explicit target must be checked through its owning preparation.');
    if (request.previousSnapshot && (!target || !sameTarget(target)))
      failure('The original frozen target must be recovered before editing its brief.');
    if (target && !sameTarget(target)) {
      if (target.phase === 'resolved') {
        if (!sourceCurrent || request.requestId === target.reviewRequestId)
          failure('The repository changed. Return to setup and review it again.');
        target = await createTarget(target);
      } else if (
        target.preview.accountId !== selection.accountId ||
        target.preview.model !== selection.model ||
        target.preview.ordinaryRuntime.runOn !== selection.runOn
      )
        failure('Check the original repository preparation before changing the execution setup.');
    } else if (!target) {
      if (request.previousSnapshot) failure(originalError);
      if (!sourceCurrent) failure('The repository changed. Return to setup and review it again.');
      target = await createTarget(null);
    }
    const retained = target;
    const expectedDraft = retained.draft;
    const draft = getChatDraft(expectedDraft.id);
    const content = (value: typeof expectedDraft) => ({
      id: value.id,
      text: value.text,
      images: value.images,
      contextBlocks: value.contextBlocks,
      settings: value.settings,
    });
    if (draft ? !equal(content(draft), content(expectedDraft)) : !saveChatDraft(expectedDraft))
      failure('The original fresh-agent draft could not be retained. Check it before continuing.');
    assertCurrent();
    const query = new URLSearchParams({
      accountId: retained.preview.accountId,
      model: retained.preview.model,
    });
    const path = `/api/repository-workspaces/${retained.preview.requestId}`;
    const status = await fetch(`${path}?${query}`);
    let workspace;
    if (status.ok) workspace = workspaceSchema.parse(await json(status));
    else if (status.status === 404 && retained.phase === 'preview_pending') {
      // 404 is not proof of absence. Only replay the original retained POST.
      const preview = await fetch('/api/repository-workspaces/preview', retained.preview);
      if (!preview.ok) failure(originalError);
      workspace = workspaceSchema.parse(await json(preview));
    } else failure(originalError);
    const check = () => {
      assertCurrent();
      readReview();
      if (
        !equal(journal.readTarget(), target) ||
        workspace!.id !== retained.preview.requestId ||
        workspace!.repository !== retained.preview.repository ||
        workspace!.conversationId
      )
        failure(originalError);
    };
    check();
    if (workspace.state === 'preview') {
      if (target.phase === 'resolved') failure(originalError);
      if (target.phase === 'preview_pending') save({ ...target, phase: 'previewed' });
      save({ ...target!, phase: 'prepare_pending' });
      const prepared = await fetch(`${path}/prepare`, {
        accountId: retained.preview.accountId,
        model: retained.preview.model,
      });
      if (!prepared.ok) failure(originalError);
      workspace = workspaceSchema.parse(await json(prepared));
      check();
    }
    if (workspace.state === 'failed' || workspace.state === 'discarded') {
      const wasResolved = target!.phase === 'resolved';
      save({ ...target!, phase: 'resolved' });
      if (wasResolved && !request.previousSnapshot) {
        await createTarget(target);
        return prepareConversationJoiningTarget({
          sourceConversationId,
          collaborationId,
          repository,
          request,
          signal,
          isCurrent,
        });
      }
      failure(
        'The original repository preparation failed. Check again to start a fresh preparation.',
      );
    }
    if (workspace.state !== 'ready' || !workspace.ordinaryRuntime)
      failure(
        'The original repository preparation is still running or already in use. Check its status again.',
      );
    const runtime = workspace.ordinaryRuntime;
    const intended = retained.preview.ordinaryRuntime;
    if (
      !equal(runtime.account, intended.runtime.account) ||
      runtime.harness.implementation !== intended.runtime.harness ||
      runtime.execution.location !== intended.runOn ||
      runtime.execution.targetId !== intended.runtime.targetId
    )
      failure(originalError);
    save({ ...target!, phase: 'resolved' });
    if (!sourceCurrent || target!.preview.repository !== repository)
      failure(
        'The original preparation is retained. Return to setup to review the changed repository.',
      );
    const currentDraft = getChatDraft(expectedDraft.id);
    if (!currentDraft || !equal(content(currentDraft), content(expectedDraft)))
      failure('The original fresh-agent draft changed. Check it before continuing.');
    return { repositoryWorkspaceId: workspace.id, permissionMode: expectedDraft.settings.mode };
  } catch (cause) {
    if (cause instanceof ConversationJoiningTargetError) throw cause;
    failure(
      target ? originalError : 'Fresh-agent setup could not be checked. Your setup stays here.',
    );
  } finally {
    window.removeEventListener(AUTH_LOST_EVENT, retire);
    window.removeEventListener(AUTH_RESTORED_EVENT, retire);
  }

  async function createTarget(previous: ConversationJoiningTargetIntent | null) {
    assertCurrent();
    let response = await fetch('/api/chat/runtime/capabilities');
    if (response.status === 404) response = await fetch('/api/chat/local-codex/capabilities');
    if (!response.ok) failure('Execution choices could not be checked. Your setup stays here.');
    const inventory = ExplicitLocalInventorySchema.parse(await json(response));
    const intent = {
      ...createChatRuntimeSelection(),
      account: request.setup.selection,
      agentProfile: selection.agent,
      execution: { location: selection.runOn, targetId: null as string | null },
      capabilityRevision: inventory.capabilityRevision,
    };
    const routes = runtimeRoutes(intent, inventory);
    intent.execution.targetId = resolveRuntimeTarget(intent, inventory);
    const route = selectedRuntimeRoute(intent, inventory);
    if (routes.length !== 1 || !route)
      failure(
        'This account has no unique execution route here. Choose an account or environment explicitly.',
      );
    intent.accountReference = route.account;
    const ready = evaluateChatRuntimeSelection(intent, normalizeLocalInventory(inventory));
    const fresh = createChatDraft();
    if (!ready.ready || !route.modes.includes(fresh.settings.mode))
      failure('The selected execution choices are unavailable for a fresh agent.');
    const catalog = await fetch(
      `/api/repository-workspaces/catalog?${new URLSearchParams({ accountId: selection.accountId, model: selection.model })}`,
    );
    if (!catalog.ok) failure('Repository access could not be checked for this account.');
    const entries = catalogSchema.parse(await json(catalog));
    const candidates = entries.available
      ? entries.repositories.filter((entry) => entry.repository === repository)
      : [];
    if (candidates.length !== 1)
      failure('This account has no unique verified access to the source repository.');
    fresh.settings = {
      ...fresh.settings,
      selection: structuredClone(request.setup.selection),
      runtimeSelection: intent,
      repositoryWorkspaceId: createBrowserId(),
      retainRuntimeIntent: true,
      search: new URLSearchParams({
        agentProfile: selection.agent!.profileId,
        profileRevision: String(selection.agent!.revision),
        ...(selection.agent!.kind ? { agentProfileKind: selection.agent!.kind } : {}),
      }).toString(),
    };
    const next = ConversationJoiningTargetIntentSchema.parse({
      collaborationId,
      reviewRequestId: request.requestId,
      phase: 'preview_pending',
      draft: fresh,
      preview: {
        requestId: fresh.settings.repositoryWorkspaceId,
        accountId: selection.accountId,
        model: selection.model,
        connectionId: candidates[0].connectionId,
        repository,
        ordinaryRuntime: {
          runOn: selection.runOn,
          runtime: { account: route.account, harness: route.harness, targetId: route.targetId },
        },
      },
    });
    target = journal.retainTarget(next, previous, readReview());
    return target;
  }
}
