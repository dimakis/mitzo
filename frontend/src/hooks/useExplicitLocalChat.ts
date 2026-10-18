import { resolveRuntimeTarget } from '../lib/chat-runtime-route';
import { getDefaultAccountModel } from '../lib/account-preference';
import type { AccountSelection } from '../types/account-selection';
import { ChatRuntimeDraftContext } from './chat-runtime-draft-context';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  SessionRuntimeBindingSchema,
  OrdinaryWorkspaceFirstCommandSchema,
  AgentLibraryVersionSchema,
  AgentContextSnapshotSchema,
  type AgentLibraryVersion,
  type AgentContextSnapshot,
  NativeContinuationConstraintSchema,
  type NativeContinuationConstraint,
  type SessionRuntimeBinding,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import {
  ExplicitLocalInventorySchema,
  normalizeLocalInventory,
  type ExplicitLocalInventory,
} from '../lib/explicit-local-chat';
import {
  createChatRuntimeSelection,
  ChatRuntimeSelectionSchema,
  replaceChatRuntimeSelection,
  chatAgentProfileFromSearch,
  retainChatRuntimeSelection,
  evaluateChatRuntimeSelection,
  type ChatRuntimeSelection,
} from '../lib/chat-runtime-selection';
/** Shared draft intent. Configuration never establishes owning admission. */
export function useExplicitLocalChat(
  draftId: string,
  saved: ChatRuntimeSelection | null | undefined,
  sessionId: string | null,
  enabled: boolean,
  search = '',
  savedAccount?: AccountSelection | null,
) {
  const retained = useContext(ChatRuntimeDraftContext);
  const seed = useCallback(() => {
    // Preferences supply editable intent, never a confirmed public billing identity.
    // Saved runtime intent (including an empty account) and session metadata win.
    const preferred = ChatRuntimeSelectionSchema.safeParse({
      ...createChatRuntimeSelection(),
      account: sessionId
        ? null
        : savedAccount === undefined
          ? getDefaultAccountModel()
          : savedAccount,
    });
    const initial = saved ?? (preferred.success ? preferred.data : createChatRuntimeSelection());
    const params = new URLSearchParams(search);
    const requested =
      params.has('agentProfile') || params.has('profileRevision') || params.has('agentProfileKind');
    return requested
      ? retainChatRuntimeSelection(initial, initial.account, chatAgentProfileFromSearch(search))!
      : initial;
  }, [saved, savedAccount, search, sessionId]);
  const [choice, setChoice] = useState(() => ({ draftId, intent: seed() }));
  const intent = retained?.selection ?? (choice.draftId === draftId ? choice.intent : seed());
  const latestIntent = useRef(intent);
  latestIntent.current = intent;
  const latestRetained = useRef(retained);
  latestRetained.current = retained;
  const previousProfileSearch = useRef({ draftId, search });
  useEffect(() => {
    const previous = previousProfileSearch.current;
    previousProfileSearch.current = { draftId, search };
    if (sessionId || previous.draftId !== draftId) return;
    const oldParams = new URLSearchParams(previous.search);
    const params = new URLSearchParams(search);
    if (
      !['agentProfile', 'profileRevision', 'agentProfileKind'].some(
        (key) => oldParams.get(key) !== params.get(key),
      )
    )
      return;
    const next = {
      ...intent,
      agentProfile: chatAgentProfileFromSearch(search),
      capabilityRevision: null,
    };
    setChoice({ draftId, intent: next });
    retained?.update(next);
  }, [draftId, sessionId, search, intent, retained]);

  const [inventory, setInventory] = useState<ExplicitLocalInventory | null>(null);
  const [enrollment, setEnrollment] = useState<'loading' | 'off' | 'on' | 'unknown'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [metaFailure, setMetaFailure] = useState<{ sessionId: string; message: string } | null>(
    null,
  );
  const [metadataLoadingForSession, setMetadataLoadingForSession] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    sessionId: string;
    binding: SessionRuntimeBinding | null;
    firstCommand: boolean;
    preparedFirst: boolean;
    ordinaryWorkspaceId?: string;
    reason?: string;
    intent: ChatRuntimeSelection | null;
    repositoryWorkspaceId?: string;
    mode?: 'ask' | 'agent' | 'auto';
    agentProfile?: AgentLibraryVersion;
    agentContext?: AgentContextSnapshot;
    nativeConstraint?: NativeContinuationConstraint;
  } | null>(null);
  const scope = useRef({ draftId, sessionId });
  scope.current = { draftId, sessionId };
  useEffect(() => {
    if (!enabled && !sessionId) {
      setEnrollment('off');
      return;
    }
    const controller = new AbortController();
    setError('');
    void Promise.resolve()
      .then(async () => {
        const response = await apiFetch('/api/chat/runtime/capabilities', {
          signal: controller.signal,
        });
        return response.status === 404
          ? apiFetch('/api/chat/local-codex/capabilities', { signal: controller.signal })
          : response;
      })
      .then(async (response) => {
        const body = await response.json();
        if (controller.signal.aborted) return;
        if (response.status === 503 && body?.code === 'entry_disabled') {
          setEnrollment('off');
          setInventory(null);
          return;
        }
        if (!response.ok) throw Error('Execution choices are unavailable. Refresh to retry.');
        setEnrollment('on');
        const next = ExplicitLocalInventorySchema.parse(body);
        setInventory(next);
        const pendingIntent = latestIntent.current;
        const pendingReference = pendingIntent.accountReference ?? null;
        const targetId =
          pendingIntent.account?.accountId && !pendingReference
            ? null
            : resolveRuntimeTarget(pendingIntent, next);
        if (
          !scope.current.sessionId &&
          pendingIntent.capabilityRevision === null &&
          pendingIntent.execution.targetId === null &&
          targetId !== null
        ) {
          const resolved = {
            ...pendingIntent,
            accountReference: pendingReference,
            execution: { ...pendingIntent.execution, targetId },
            capabilityRevision: next.capabilityRevision,
          };
          setChoice({ draftId: scope.current.draftId, intent: resolved });
          latestRetained.current?.update(resolved, 'hydrate');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('Execution choices are unavailable. Refresh to retry.');
          setEnrollment('unknown');
          setInventory(null);
        }
      });
    return () => controller.abort();
  }, [enabled, sessionId, attempt]);
  useEffect(() => {
    if (!sessionId) return;
    setMetaFailure(null);
    setMetadataLoadingForSession(sessionId);
    const controller = new AbortController();
    void Promise.resolve()
      .then(() =>
        apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/meta`, {
          signal: controller.signal,
        }),
      )
      .then(async (response) => {
        if (!response.ok) throw Error('Metadata unavailable');
        const body = await response.json();
        if (controller.signal.aborted || scope.current.sessionId !== sessionId) return;
        const parsed =
          body.runtimeBinding == null
            ? null
            : SessionRuntimeBindingSchema.parse(body.runtimeBinding);
        const ordinaryWorkspaceId =
          body.ordinaryWorkspaceId == null
            ? undefined
            : OrdinaryWorkspaceFirstCommandSchema.shape.workspace.shape.workspaceId.parse(
                body.ordinaryWorkspaceId,
              );
        const preparedFirst = body.runtimeCommandScope === 'prepared-first-command';
        if (
          (ordinaryWorkspaceId !== undefined || preparedFirst) &&
          (!ordinaryWorkspaceId ||
            body.repositoryWorkspaceId != null ||
            parsed?.version !== 2 ||
            parsed.harness.implementation !== 'codex' ||
            parsed.execution.location !== 'local' ||
            parsed.account.provider !== 'openai-codex')
        )
          throw Error('Ordinary conversation identity unavailable');
        setMeta({
          sessionId,
          ordinaryWorkspaceId,
          preparedFirst,
          binding: parsed,
          ...(parsed?.harness.implementation === 'gemini'
            ? {
                nativeConstraint: NativeContinuationConstraintSchema.parse(
                  body.runtimeNativeConstraint,
                ),
              }
            : {}),
          firstCommand:
            body.runtimeCommandScope === 'first-command-only' ||
            (!!parsed && body.runtimeCommandScope !== 'conversation'),
          reason:
            typeof body.runtimeCommandReason === 'string' && body.runtimeCommandReason.length <= 200
              ? body.runtimeCommandReason
              : undefined,
          intent:
            parsed && (body.modelSelection?.model ?? body.accountBinding?.model)
              ? ChatRuntimeSelectionSchema.parse({
                  version: 1,
                  account: {
                    accountId: parsed.account.accountId,
                    model: body.modelSelection?.model ?? body.accountBinding?.model,
                    reasoningEffort: body.modelSelection?.reasoningEffort ?? null,
                  },
                  accountReference: parsed.account,
                  agentProfile: body.agentProfile
                    ? {
                        profileId: body.agentProfile.profileId,
                        revision: body.agentProfile.revision,
                        ...(body.agentProfile.kind ? { kind: body.agentProfile.kind } : {}),
                      }
                    : null,
                  execution: {
                    location: parsed.execution.location,
                    targetId: parsed.version === 2 ? parsed.execution.targetId : null,
                  },
                  capabilityRevision: null,
                })
              : null,
          agentProfile:
            parsed && body.agentProfile
              ? AgentLibraryVersionSchema.parse(body.agentProfile)
              : undefined,
          agentContext:
            parsed && body.agentContext
              ? AgentContextSnapshotSchema.parse(body.agentContext)
              : undefined,
          repositoryWorkspaceId: body.repositoryWorkspaceId,
          mode: body.mode,
        });
        setMetadataLoadingForSession(null);
      })
      .catch(() => {
        if (!controller.signal.aborted && scope.current.sessionId === sessionId) {
          setMetaFailure({
            sessionId,
            message: 'Conversation settings are unavailable. Retry to continue.',
          });
          setMetadataLoadingForSession(null);
        }
      });
    return () => controller.abort();
  }, [sessionId, attempt]);
  const currentMeta = meta?.sessionId === sessionId ? meta : null;
  const metadataError = metaFailure?.sessionId === sessionId ? metaFailure.message : undefined;
  const metadataUnavailable = !!sessionId && !!metadataError;
  const metadataPending =
    !!sessionId && (!currentMeta || metadataUnavailable || metadataLoadingForSession === sessionId);
  const bound = !!sessionId && !!currentMeta?.binding;
  const continuation =
    bound &&
    !currentMeta?.firstCommand &&
    ['codex', 'responses', 'claude-sdk', 'gemini'].includes(
      currentMeta?.binding?.harness.implementation ?? '',
    );
  const preparedFirst = bound && !!currentMeta?.preparedFirst && !metadataPending;
  const commandAvailable = !metadataPending && (preparedFirst || continuation);
  const [future, setFuture] = useState<{ sessionId: string; intent: ChatRuntimeSelection } | null>(
    null,
  );
  useEffect(() => {
    if (!sessionId || !currentMeta?.intent || !inventory) return;
    setFuture((previous) =>
      previous?.sessionId === sessionId
        ? previous
        : {
            sessionId,
            intent: { ...currentMeta.intent!, capabilityRevision: inventory.capabilityRevision },
          },
    );
  }, [sessionId, currentMeta, inventory]);
  const selectedIntent =
    bound && currentMeta?.intent
      ? future?.sessionId === sessionId
        ? future.intent
        : currentMeta.intent
      : intent;
  const selectedLocal = selectedIntent.execution.location === 'local';
  // A preference alone must not enroll a server with runtime entry disabled.
  // Explicit/shared edits and saved runtime intent still retain their own route.
  const retainedExplicitIntent =
    selectedLocal ||
    !!saved ||
    !!selectedIntent.execution.targetId ||
    (!!selectedIntent.account && (!!selectedIntent.accountReference || !!retained?.selection));
  const visible =
    bound ||
    metadataUnavailable ||
    (!sessionId &&
      enabled &&
      (enrollment === 'on' || enrollment === 'unknown' || retainedExplicitIntent));
  const evaluation = evaluateChatRuntimeSelection(
    selectedIntent,
    inventory ? normalizeLocalInventory(inventory) : null,
  );
  const nativeMismatch =
    currentMeta?.nativeConstraint &&
    (selectedIntent.account?.model !== currentMeta.nativeConstraint.model ||
      (selectedIntent.account?.reasoningEffort ?? null) !== currentMeta.nativeConstraint.thinking);
  const reason = nativeMismatch
    ? currentMeta!.nativeConstraint!.reason
    : metadataPending
      ? (metadataError ?? 'Loading conversation settings…')
      : bound && !commandAvailable
        ? (currentMeta?.reason ??
          `This ${currentMeta?.binding?.execution.location === 'openshell' ? 'OpenShell' : 'Local'} conversation supports its first command only. Start a new chat for another command.`)
        : sessionId && !currentMeta
          ? (metadataError ?? 'Loading conversation settings…')
          : !visible
            ? enabled && !sessionId && enrollment === 'loading'
              ? 'Checking execution choices…'
              : undefined
            : enrollment !== 'on'
              ? error || 'Execution choices are unavailable. Refresh to retry.'
              : selectedIntent.account?.accountId && !selectedIntent.accountReference
                ? 'The selected account identity is unconfirmed. Choose the account again to confirm authentication and billing before sending.'
                : selectedIntent.execution.location === 'openshell' &&
                    inventory?.locations.some(
                      (entry) => entry.location === 'openshell' && entry.status === 'unavailable',
                    )
                  ? ((inventory &&
                      normalizeLocalInventory(inventory).locations.find(
                        (location) => location.location === 'openshell' && !location.available,
                      )?.reason) ??
                    evaluation.issues[0]?.message)
                  : !selectedIntent.agentProfile
                    ? 'Choose an agent to start.'
                    : selectedIntent.accountReference &&
                        inventory?.accounts.some(
                          (entry) =>
                            entry.account.accountId ===
                              selectedIntent.accountReference!.accountId &&
                            (entry.account.provider !== selectedIntent.accountReference!.provider ||
                              entry.account.profileRevision !==
                                selectedIntent.accountReference!.profileRevision),
                        )
                      ? inventory.accounts.find(
                          (entry) =>
                            entry.account.accountId === selectedIntent.accountReference!.accountId,
                        )?.account.provider !== selectedIntent.accountReference.provider
                        ? 'The selected account provider changed, which may change authentication or billing. Choose the account again before sending.'
                        : 'The selected account configuration changed. Choose the account again before sending.'
                      : evaluation.issues[0]?.message;
  const selectedAccountId = selectedIntent.account?.accountId;
  const accountNeedsConfirmation =
    !bound &&
    !!selectedAccountId &&
    !!inventory?.accounts.some((entry) => entry.account.accountId === selectedAccountId) &&
    !inventory.accounts.some(
      (entry) =>
        entry.account.accountId === selectedAccountId &&
        entry.account.accountId === selectedIntent.accountReference?.accountId &&
        entry.account.provider === selectedIntent.accountReference?.provider &&
        entry.account.profileRevision === selectedIntent.accountReference?.profileRevision,
    );
  const update = (next: ChatRuntimeSelection, explicitAccountChoice = false) => {
    const identityChanged =
      explicitAccountChoice ||
      next.account?.accountId !== selectedIntent.account?.accountId ||
      next.execution.location !== selectedIntent.execution.location;
    const matchingAccounts = inventory?.accounts.filter(
      (entry) => entry.account.accountId === next.account?.accountId,
    );
    // Only the Account action can accept a current public identity. Capability
    // review, environment/model edits and hydration cannot adopt unknown billing.
    const accountReference = !next.account?.accountId
      ? null
      : explicitAccountChoice
        ? matchingAccounts?.length === 1
          ? matchingAccounts[0].account
          : null
        : next.accountReference?.accountId === next.account.accountId
          ? next.accountReference
          : null;
    const referenced = { ...next, accountReference };
    const reviewed = inventory
      ? {
          ...referenced,
          execution: {
            ...next.execution,
            targetId:
              identityChanged || next.execution.targetId === null
                ? next.account?.accountId && !accountReference
                  ? null
                  : resolveRuntimeTarget(referenced, inventory)
                : next.execution.targetId,
          },
          capabilityRevision: inventory.capabilityRevision,
        }
      : referenced;
    if (sessionId) {
      if (
        continuation &&
        currentMeta?.intent &&
        replaceChatRuntimeSelection(selectedIntent, reviewed, currentMeta.intent).accepted
      )
        setFuture({ sessionId, intent: reviewed });
      return;
    }
    setChoice({ draftId, intent: reviewed });
    retained?.update(reviewed);
  };
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    intent: selectedIntent,
    inventory,
    continuation,
    preparedFirst,
    commandAvailable,
    ordinaryWorkspaceId: currentMeta?.ordinaryWorkspaceId,
    repositoryWorkspaceId: currentMeta?.repositoryWorkspaceId,
    agentProfile: currentMeta?.agentProfile,
    agentContext: currentMeta?.agentContext,
    mode: currentMeta?.mode,
    nativeConstraint: currentMeta?.nativeConstraint,
    accountNeedsConfirmation,
    visible,
    selectedLocal,
    bound,
    binding: currentMeta?.binding,
    reason,
    error,
    metadataUnavailable,
    metadataPending,
    refresh,
    update,
    review: () => {
      update({
        ...selectedIntent,
        execution: {
          ...selectedIntent.execution,
          targetId:
            selectedIntent.execution.targetId ?? resolveRuntimeTarget(selectedIntent, inventory),
        },
        capabilityRevision: inventory?.capabilityRevision ?? null,
      });
    },
  };
}
