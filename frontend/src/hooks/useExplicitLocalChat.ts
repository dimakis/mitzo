import { ChatRuntimeDraftContext } from './chat-runtime-draft-context';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  SessionRuntimeBindingSchema,
  AgentLibraryVersionSchema,
  AgentContextSnapshotSchema,
  type AgentLibraryVersion,
  type AgentContextSnapshot,
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
) {
  const retained = useContext(ChatRuntimeDraftContext);
  const seed = useCallback(() => {
    const params = new URLSearchParams(search);
    const requested =
      params.has('agentProfile') || params.has('profileRevision') || params.has('agentProfileKind');
    return requested
      ? retainChatRuntimeSelection(
          saved ?? createChatRuntimeSelection(),
          saved?.account ?? null,
          chatAgentProfileFromSearch(search),
        )!
      : (saved ?? createChatRuntimeSelection());
  }, [saved, search]);
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
    reason?: string;
    intent: ChatRuntimeSelection | null;
    repositoryWorkspaceId?: string;
    mode?: 'ask' | 'agent' | 'auto';
    agentProfile?: AgentLibraryVersion;
    agentContext?: AgentContextSnapshot;
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
        const targets = next.targets.filter(
          (target) => target.location === pendingIntent.execution.location,
        );
        if (
          !scope.current.sessionId &&
          pendingIntent.capabilityRevision === null &&
          pendingIntent.execution.targetId === null &&
          targets.length === 1
        ) {
          const resolved = {
            ...pendingIntent,
            execution: { ...pendingIntent.execution, targetId: targets[0].targetId },
            capabilityRevision: next.capabilityRevision,
          };
          setChoice({ draftId: scope.current.draftId, intent: resolved });
          latestRetained.current?.update(resolved);
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
        setMeta({
          sessionId,
          binding: parsed,
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
    bound && !currentMeta?.firstCommand && currentMeta?.binding?.harness.implementation === 'codex';
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
  const retainedExplicitIntent =
    selectedLocal || !!saved || !!selectedIntent.account || !!selectedIntent.execution.targetId;
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
  const reason = metadataPending
    ? (metadataError ?? 'Loading conversation settings…')
    : bound && !continuation
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
                ? 'Choose a published agent revision before sending.'
                : evaluation.issues[0]?.message;
  const update = (next: ChatRuntimeSelection, explicitAccountChoice = false) => {
    const targets =
      inventory?.targets.filter((target) => target.location === next.execution.location) ?? [];
    const reviewed = inventory
      ? {
          ...next,
          accountReference: !next.account?.accountId
            ? null
            : explicitAccountChoice ||
                !next.accountReference ||
                next.accountReference.accountId !== next.account?.accountId
              ? (inventory.accounts.find(
                  (entry) => entry.account.accountId === next.account?.accountId,
                )?.account ?? next.accountReference)
              : next.accountReference,
          execution: {
            ...next.execution,
            targetId:
              next.execution.targetId ?? (targets.length === 1 ? targets[0].targetId : null),
          },
          capabilityRevision: inventory.capabilityRevision,
        }
      : next;
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
  return {
    intent: selectedIntent,
    inventory,
    continuation,
    repositoryWorkspaceId: currentMeta?.repositoryWorkspaceId,
    agentProfile: currentMeta?.agentProfile,
    agentContext: currentMeta?.agentContext,
    mode: currentMeta?.mode,
    visible,
    selectedLocal,
    bound,
    binding: currentMeta?.binding,
    reason,
    error,
    metadataUnavailable,
    metadataPending,
    refresh: () => setAttempt((value) => value + 1),
    update,
    review: () => {
      const targets =
        inventory?.targets.filter(
          (target) => target.location === selectedIntent.execution.location,
        ) ?? [];
      update({
        ...selectedIntent,
        execution: {
          ...selectedIntent.execution,
          targetId:
            selectedIntent.execution.targetId ??
            (targets.length === 1 ? targets[0].targetId : null),
        },
        capabilityRevision: inventory?.capabilityRevision ?? null,
      });
    },
  };
}
