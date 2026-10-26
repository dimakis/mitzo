import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import {
  AccountBindingSchema,
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  type SessionRuntimeBinding,
  type MitzoMode,
} from '@mitzo/protocol';
import { z } from 'zod';
import { HomeDialog } from './HomeDialog';
import { AccountModelPicker } from './AccountModelPicker';
import { ChatExecutionPicker } from './ChatExecutionPicker';
import { ChatAgentProfilePicker } from './ChatAgentProfilePicker';
import { RepositoryChatPicker, type RepositoryChatSelection } from './RepositoryChatPicker';
import { ChatStatusMessage } from './ChatStatusMessage';
import { ChatRuntimeDraftContext } from '../hooks/chat-runtime-draft-context';
import { useExplicitLocalChat } from '../hooks/useExplicitLocalChat';
import {
  createChatRuntimeSelection,
  ChatRuntimeSelectionSchema,
} from '../lib/chat-runtime-selection';
import { runtimeModelAccounts, selectedRuntimeRoute } from '../lib/chat-runtime-route';
import { prepareLocalFirstCommand } from '../lib/explicit-local-chat';
import { createBrowserId } from '../lib/browser-crypto';
import {
  apiFetch,
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
  CONVERSATION_JOINING_RECOVERY_PREFIX,
} from '../lib/api-fetch';
import {
  NativeContinuationReviewSchema,
  commitNativeContinuation,
  canReviewNativeContinuationAgain,
  discardUnclaimedNativeContinuation,
  type NativeContinuationReview,
} from '../lib/legacy-native-continuation';
import './LegacyNativeContinuation.css';

interface Props {
  sourceSessionId: string;
  binding: SessionRuntimeBinding | null | undefined;
  model: string;
  thinking: string | null;
  mode: MitzoMode;
  beforeOpenNative?(): boolean;
  onStop?(): void;
}
type Source = {
  account: SessionRuntimeBinding['account'];
  model: string;
  thinking: string | null;
  mode: MitzoMode;
  targetId: string | null;
};

/** Historical pre-runtime sessions get the same visible continuation action.
 * Public metadata is eligibility only; preview and ordinary admission recheck it. */
export function LegacyNativeContinuation(props: Props) {
  const [fallback, setFallback] = useState<{ id: string; source: Source } | null>(null);
  useEffect(() => {
    if (props.binding) return;
    const controller = new AbortController();
    void apiFetch(`/api/sessions/${encodeURIComponent(props.sourceSessionId)}/meta`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const meta = await response.json();
        if (
          controller.signal.aborted ||
          meta.runtimeBinding ||
          meta.symposiumConfig ||
          meta.isHidden
        )
          return;
        const account = AccountBindingSchema.safeParse(meta.accountBinding);
        if (!account.success || account.data.provider !== 'openai') return;
        setFallback({
          id: props.sourceSessionId,
          source: {
            account: {
              accountId: account.data.accountId,
              provider: account.data.provider,
              profileRevision: account.data.profileRevision,
            },
            model: meta.modelSelection?.model ?? account.data.model,
            thinking: meta.modelSelection?.reasoningEffort ?? null,
            mode: ['ask', 'agent', 'auto'].includes(meta.mode) ? meta.mode : 'agent',
            targetId: null,
          },
        });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [props.binding, props.sourceSessionId]);
  const binding = props.binding;
  const source: Source | null = binding
    ? binding.harness.implementation === 'responses' && binding.account.provider === 'openai'
      ? {
          account: binding.account,
          model: props.model,
          thinking: props.thinking,
          mode: props.mode,
          targetId: binding.version === 2 ? binding.execution.targetId : null,
        }
      : null
    : fallback?.id === props.sourceSessionId
      ? fallback.source
      : null;
  if (!source) return null;
  return (
    <ChatRuntimeDraftContext.Provider value={null}>
      <NativeContinuationForm key={props.sourceSessionId} {...props} source={source} />
    </ChatRuntimeDraftContext.Provider>
  );
}
const Saved = z.object({
  text: z.string(),
  selection: ChatRuntimeSelectionSchema.optional(),
  repositoryWorkspaceId: z.uuid().optional(),
  review: NativeContinuationReviewSchema.nullable(),
  attempted: z.boolean(),
  contextApproved: z.boolean(),
  uncertaintyApproved: z.boolean(),
  selectionApproved: z.boolean(),
});
function NativeContinuationForm({
  sourceSessionId,
  source,
  beforeOpenNative,
  onStop,
}: Props & { source: Source }) {
  const key = `${CONVERSATION_JOINING_RECOVERY_PREFIX}legacy-native:${sourceSessionId}`;
  const [saved] = useState(() => {
    try {
      const parsed = Saved.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'));
      return parsed.success &&
        (!parsed.data.review || parsed.data.review.sourceSessionId === sourceSessionId)
        ? parsed.data
        : null;
    } catch {
      return null;
    }
  });
  const seed = useMemo(
    () =>
      saved?.selection ?? {
        ...createChatRuntimeSelection(),
        account: {
          accountId: source.account.accountId,
          model: source.model,
          reasoningEffort: source.thinking,
        },
        accountReference: source.account,
        agentProfile: {
          kind: 'builtin' as const,
          profileId: DEFAULT_MITZO_PROFILE_ID,
          revision: DEFAULT_MITZO_PROFILE_REVISION,
        },
        execution: { location: 'local' as const, targetId: null },
      },
    [saved, source.account, source.model, source.thinking],
  );
  const runtime = useExplicitLocalChat(`legacy-native:${sourceSessionId}`, seed, null, true);
  const [open, setOpen] = useState(false),
    [text, setText] = useState(saved?.text ?? ''),
    [review, setReview] = useState<NativeContinuationReview | null>(saved?.review ?? null),
    [attempted, setAttempted] = useState(saved?.attempted ?? false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [canReviewAgain, setCanReviewAgain] = useState(false);
  const [contextApproved, setContextApproved] = useState(saved?.contextApproved ?? false),
    [uncertaintyApproved, setUncertaintyApproved] = useState(saved?.uncertaintyApproved ?? false),
    [selectionApproved, setSelectionApproved] = useState(saved?.selectionApproved ?? false);
  const [repository, setRepository] = useState<RepositoryChatSelection | null>(null);
  const operationGeneration = useRef(0);
  const inFlight = useRef(false),
    navigate = useNavigate();
  const connectionId = useMitzoStore((s) => s.connection.clientId),
    switchSession = useMitzoStore((s) => s.switchSession);
  const route = selectedRuntimeRoute(runtime.intent, runtime.inventory);
  const persist = (nextAttempted = attempted, nextReview = review, fresh = false) => {
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          text,
          selection: runtime.intent,
          repositoryWorkspaceId: repository?.repositoryWorkspaceId ?? saved?.repositoryWorkspaceId,
          review: nextReview,
          attempted: nextAttempted,
          contextApproved: fresh ? false : contextApproved,
          uncertaintyApproved: fresh ? false : uncertaintyApproved,
          selectionApproved: fresh ? false : selectionApproved,
        }),
      );
      return true;
    } catch {
      setError('Could not save this continuation review on this device. Keep it open and retry.');
      return false;
    }
  };
  useEffect(() => {
    const close = () => {
      operationGeneration.current++;
      inFlight.current = false;
      setBusy(false);
      setOpen(false);
      setReview(null);
      setAttempted(false);
      setCanReviewAgain(false);
      sessionStorage.removeItem(key);
    };
    window.addEventListener(AUTH_LOST_EVENT, close);
    window.addEventListener(AUTH_RESTORED_EVENT, close);
    return () => {
      window.removeEventListener(AUTH_LOST_EVENT, close);
      window.removeEventListener(AUTH_RESTORED_EVENT, close);
    };
  }, [key]);
  const observeRecovery = async (selected: NativeContinuationReview, generation: number) => {
    try {
      const allowed = await canReviewNativeContinuationAgain(sourceSessionId, selected);
      if (generation === operationGeneration.current) setCanReviewAgain(allowed);
    } catch {
      if (generation === operationGeneration.current) setCanReviewAgain(false);
    }
  };
  const discardUnclaimed = async () => {
    if (inFlight.current || !review || !canReviewAgain) return;
    const generation = ++operationGeneration.current;
    inFlight.current = true;
    setBusy(true);
    try {
      await discardUnclaimedNativeContinuation(sourceSessionId, review);
      if (generation !== operationGeneration.current) return;
      if (!persist(false, null, true)) return;
      setReview(null);
      setAttempted(false);
      setCanReviewAgain(false);
      setContextApproved(false);
      setUncertaintyApproved(false);
      setSelectionApproved(false);
      setError('');
      runtime.refresh();
    } catch (caught) {
      if (generation !== operationGeneration.current) return;
      setCanReviewAgain(false);
      setError(
        caught instanceof Error ? caught.message : 'The original admission remains unconfirmed.',
      );
    } finally {
      if (generation === operationGeneration.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const preview = async () => {
    if (inFlight.current || attempted) return;
    const prepared = prepareLocalFirstCommand(runtime.intent, runtime.inventory, {
      clientMsgId: createBrowserId(),
      repositoryWorkspaceId: repository?.repositoryWorkspaceId,
      mode: source.mode,
      text,
    });
    if (!prepared.request || prepared.request.runtime.harness !== 'codex') {
      setError(
        prepared.reason ??
          'Select the original account, Local Mac and a prepared native workspace.',
      );
      return;
    }
    const generation = ++operationGeneration.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/sessions/${encodeURIComponent(sourceSessionId)}/native-continuation/preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: prepared.request }),
        },
      );
      const body = await response.json();
      if (generation !== operationGeneration.current) return;
      if (!response.ok)
        throw Error(
          typeof body?.error === 'string' ? body.error : 'Native continuation review unavailable',
        );
      const next = NativeContinuationReviewSchema.parse(body);
      if (
        next.sourceSessionId !== sourceSessionId ||
        next.account.accountId !== source.account.accountId ||
        next.account.provider !== source.account.provider ||
        next.account.profileRevision !== source.account.profileRevision ||
        next.commandId !== prepared.request.clientMsgId
      )
        throw Error('Native continuation review identity changed');
      setReview(next);
      setCanReviewAgain(false);
      setContextApproved(false);
      setUncertaintyApproved(false);
      setSelectionApproved(false);
      persist(false, next, true);
    } catch (caught) {
      if (generation !== operationGeneration.current) return;
      setError(caught instanceof Error ? caught.message : 'Native continuation review unavailable');
    } finally {
      if (generation === operationGeneration.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const commit = async () => {
    if (
      inFlight.current ||
      !review ||
      !connectionId ||
      !contextApproved ||
      (review.uncertainOutcomes && !uncertaintyApproved) ||
      (review.selectionChanged && !selectionApproved)
    )
      return;
    if (beforeOpenNative && !beforeOpenNative()) {
      setError(
        'Could not save the original conversation draft. Keep this conversation open and retry.',
      );
      return;
    }
    if (!persist(true)) return;
    const generation = ++operationGeneration.current;
    inFlight.current = true;
    setBusy(true);
    setAttempted(true);
    setCanReviewAgain(false);
    setError('');
    try {
      const receipt = await commitNativeContinuation(
        sourceSessionId,
        review,
        connectionId,
        uncertaintyApproved,
        selectionApproved,
      );
      if (generation !== operationGeneration.current) return;
      if (receipt.state !== 'consumed' || !receipt.ok) {
        setError(
          'Native admission is uncertain. Its original command and source are retained. Check admission to observe that exact attempt; no command is replayed.',
        );
        return;
      }
      if (beforeOpenNative && !beforeOpenNative()) {
        setError(
          'The native conversation was accepted, but the original draft could not be saved. Save it before checking admission again.',
        );
        return;
      }
      persist(true);
      switchSession(receipt.sessionId);
      navigate(`/chat/${encodeURIComponent(receipt.sessionId)}`);
    } catch (caught) {
      if (generation !== operationGeneration.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : 'Native admission is unconfirmed. Check the original review again.',
      );
      await observeRecovery(review, generation);
    } finally {
      if (generation === operationGeneration.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const frozen = busy || !!review;
  return (
    <>
      <ChatStatusMessage
        status="Historical Responses execution is retired. Review a linked native continuation to request new work."
        action={{
          label: 'Continue with Codex',
          onClick: () => {
            setOpen(true);
            if (attempted && review) void observeRecovery(review, operationGeneration.current);
          },
        }}
      />
      <HomeDialog
        title="Review native continuation"
        className="native-continuation-dialog"
        open={open}
        onClose={() => {
          persist();
          setOpen(false);
        }}
      >
        <div className="native-continuation-form">
          <p>
            Choose a repository and enter the work to continue. The original conversation and draft
            stay saved.
          </p>
          <fieldset disabled={frozen} hidden={!!review}>
            <AccountModelPicker
              sessionId={null}
              preferredModel={source.model}
              onChange={() => {}}
              lockAccount
              controlled={{
                accounts: runtimeModelAccounts(runtime.intent, runtime.inventory).filter(
                  (account) => account.id === source.account.accountId,
                ),
                selection: runtime.intent.account,
                accountReference: runtime.intent.accountReference,
                onChange: (account) => runtime.update({ ...runtime.intent, account }, true),
                onRefresh: runtime.refresh,
              }}
            />
            <ChatExecutionPicker runtime={runtime} executionLocked disabled={frozen} />
            <ChatAgentProfilePicker
              sessionId={null}
              search=""
              onChange={() => {}}
              updateSearchParams={false}
              controlled={{
                versions: runtime.inventory?.agentProfiles ?? [],
                selection: runtime.intent.agentProfile,
                onChange: (agentProfile) =>
                  runtime.update({ ...runtime.intent, agentProfile, capabilityRevision: null }),
              }}
            />
            {runtime.intent.account && (
              <RepositoryChatPicker
                accountId={source.account.accountId}
                model={runtime.intent.account.model}
                draftScoped
                required
                initialPreparationId={saved?.repositoryWorkspaceId}
                ordinaryRuntime={
                  route?.harness === 'codex'
                    ? {
                        runOn: 'local',
                        runtime: {
                          account: source.account,
                          harness: 'codex',
                          targetId: runtime.intent.execution.targetId ?? '',
                        },
                      }
                    : undefined
                }
                onChange={setRepository}
              />
            )}
            <label>
              New request
              <textarea value={text} onChange={(event) => setText(event.target.value)} />
            </label>
          </fieldset>
          {!review && (
            <>
              {runtime.reason && <p role="status">{runtime.reason}</p>}
              <p>Stop the original execution before review if it is still open.</p>
              <div className="home-inline-actions">
                {onStop && (
                  <button className="home-secondary" onClick={onStop} disabled={busy}>
                    Stop original execution
                  </button>
                )}
                <button
                  className="home-secondary"
                  disabled={
                    busy ||
                    !!runtime.reason ||
                    !text.trim() ||
                    !repository?.repositoryWorkspaceId ||
                    repository.blocked ||
                    route?.harness !== 'codex' ||
                    runtime.intent.execution.location !== 'local'
                  }
                  onClick={() => void preview()}
                >
                  Review native continuation
                </button>
              </div>
            </>
          )}
          {review && (
            <>
              <p>
                Codex receives the historical text below and your separate new request. Earlier
                commands and checkpoints stay in the original conversation.
              </p>
              <p>
                <strong>New request:</strong> {text}
              </p>
              <p>
                From {review.sourceSessionId} to {review.nativeSessionId}.
              </p>
              <p>
                Original: {review.sourceSelection.model} ·{' '}
                {review.sourceSelection.thinking ?? 'model default'} · {review.sourceSelection.mode}{' '}
                · {review.sourceSelection.targetId ?? 'historical host'}.<br />
                Native: {review.command.selection.model} ·{' '}
                {review.command.selection.thinking ?? 'model default'} ·{' '}
                {review.command.selection.permission.mode} · {review.command.runtime.targetId}.
              </p>
              <p>
                {review.retainedPendingCommands} pending commands remain in the original
                conversation. {review.omittedNonTextBlocks} non-text blocks and{' '}
                {review.omittedEarlierCharacters} earlier characters were omitted.
              </p>
              <pre aria-label="Exact historical context">{review.context}</pre>
              <details>
                <summary>Exact native first message</summary>
                <pre>{review.command.payload.text}</pre>
              </details>
              <label className="native-continuation-check">
                <input
                  type="checkbox"
                  disabled={busy || attempted}
                  checked={contextApproved}
                  onChange={(e) => setContextApproved(e.target.checked)}
                />
                I reviewed the exact context and separate new request.
              </label>
              {review.uncertainOutcomes && (
                <label className="native-continuation-check">
                  <input
                    type="checkbox"
                    disabled={busy || attempted}
                    checked={uncertaintyApproved}
                    onChange={(e) => setUncertaintyApproved(e.target.checked)}
                  />
                  I understand earlier effects may be uncertain. Inspect actual state before
                  repeating a change.
                </label>
              )}
              {review.selectionChanged && (
                <label className="native-continuation-check">
                  <input
                    type="checkbox"
                    disabled={busy || attempted}
                    checked={selectionApproved}
                    onChange={(e) => setSelectionApproved(e.target.checked)}
                  />
                  I approve the displayed model, thinking, permission and target changes.
                </label>
              )}
              <div className="home-inline-actions">
                <button
                  className="home-secondary"
                  disabled={
                    busy ||
                    !connectionId ||
                    !contextApproved ||
                    (review.uncertainOutcomes && !uncertaintyApproved) ||
                    (review.selectionChanged && !selectionApproved)
                  }
                  onClick={() => void commit()}
                >
                  {attempted ? 'Check admission' : 'Start reviewed native continuation'}
                </button>
                {attempted && canReviewAgain && (
                  <button
                    className="home-secondary"
                    disabled={busy}
                    onClick={() => void discardUnclaimed()}
                  >
                    Discard rejected attempt and review again
                  </button>
                )}
                {!attempted && (
                  <button
                    className="home-secondary"
                    disabled={busy}
                    onClick={() => {
                      setReview(null);
                      setError('');
                    }}
                  >
                    Edit new request
                  </button>
                )}
              </div>
            </>
          )}
          {busy && (
            <p role="status">
              {attempted ? 'Checking exact native admission…' : 'Preparing context review…'}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      </HomeDialog>
    </>
  );
}
