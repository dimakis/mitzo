import { ChatRuntimeDraftContext } from './chat-runtime-draft-context';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { SessionRuntimeBindingSchema, type SessionRuntimeBinding } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import {
  ExplicitLocalInventorySchema,
  normalizeLocalInventory,
  type ExplicitLocalInventory,
} from '../lib/explicit-local-chat';
import {
  createChatRuntimeSelection,
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
  const [meta, setMeta] = useState<{
    sessionId: string;
    binding: SessionRuntimeBinding | null;
    firstCommand: boolean;
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
      .then(() => apiFetch('/api/chat/local-codex/capabilities', { signal: controller.signal }))
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
            parsed?.execution.location === 'local',
        });
      })
      .catch(() => {
        if (!controller.signal.aborted && scope.current.sessionId === sessionId)
          setMetaFailure({
            sessionId,
            message: 'Conversation settings are unavailable. Retry to continue.',
          });
      });
    return () => controller.abort();
  }, [sessionId, attempt]);
  const currentMeta = meta?.sessionId === sessionId ? meta : null;
  const metadataError = metaFailure?.sessionId === sessionId ? metaFailure.message : undefined;
  const metadataUnavailable = !!sessionId && !currentMeta && !!metadataError;
  const bound = !!sessionId && !!currentMeta?.firstCommand;
  const selectedLocal = intent.execution.location === 'local';
  const visible =
    bound ||
    metadataUnavailable ||
    (!sessionId && enabled && (enrollment === 'on' || enrollment === 'unknown' || selectedLocal));
  const evaluation = evaluateChatRuntimeSelection(
    intent,
    inventory ? normalizeLocalInventory(inventory) : null,
  );
  const reason = bound
    ? 'This Local conversation supports its first command only. Start a new chat for another command.'
    : sessionId && !currentMeta
      ? (metadataError ?? 'Loading conversation settings…')
      : !visible
        ? enabled && !sessionId && enrollment === 'loading'
          ? 'Checking execution choices…'
          : undefined
        : enrollment !== 'on'
          ? error || 'Execution choices are unavailable. Refresh to retry.'
          : intent.execution.location === 'openshell'
            ? 'OpenShell is unavailable.'
            : !intent.agentProfile
              ? 'Choose a published agent revision before sending.'
              : evaluation.issues[0]?.message;
  const update = (next: ChatRuntimeSelection) => {
    if (sessionId) return;
    setChoice({ draftId, intent: next });
    retained?.update(next);
  };
  return {
    intent,
    inventory,
    visible,
    selectedLocal,
    bound,
    binding: currentMeta?.binding,
    reason,
    error,
    metadataUnavailable,
    metadataPending: !!sessionId && !currentMeta,
    refresh: () => setAttempt((value) => value + 1),
    update,
    review: () => update({ ...intent, capabilityRevision: inventory?.capabilityRevision ?? null }),
  };
}
