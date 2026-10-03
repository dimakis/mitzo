import { createPortal } from 'react-dom';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type {
  SymposiumConfig,
  SymposiumProfileDefinition,
  ValidAccountBinding,
} from '@mitzo/protocol';
import { canRequestRuntime } from '../lib/symposium-status';
import { apiFetch } from '../lib/api-fetch';
import { AccountModelPicker, type AccountSelection } from './AccountModelPicker';
import { SymposiumProfilePicker, type SymposiumProfileSelection } from './SymposiumProfilePicker';
import './AddReviewerSheet.css';
import {
  reviewerOperations,
  reviewerOperationScope,
  type ReviewerApproval,
  type ReviewerOperation,
} from '../lib/symposium-reviewer-operations';

type Status = {
  sessionId?: string;
  deliveries?: {
    sessionId: string;
    sourceSeatId: string | null;
    idempotencyKey: string;
    recipients?: { seatId: string }[];
    recipientSeatIds?: string[];
    originalContent: string;
  }[];
  config: SymposiumConfig | null;
  ordinaryAccountId?: string | null;
  runtimeAvailable: boolean;
  runtimeVerification?: string;
  initialProfileSelections?: Record<string, SymposiumProfileSelection>;
  seats: {
    seatId: string;
    membership: {
      sessionId?: string;
      seatId?: string;
      configRevision?: number;
      idempotencyKey?: string;
      action?: string;
      reason?: string;
      reconciliation?: string;
      state: string;
      generation: number;
    } | null;
  }[];
};
type Mode = 'independent' | 'summary' | 'selected-turns' | 'full-context';
const confirmation = 'ADD CROSS-ACCOUNT SEAT';
class ReviewerRequestError extends Error {
  constructor(
    message: string,
    readonly noSeatMutation: boolean,
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal,
): Promise<T> {
  const response = await apiFetch(
    path,
    body === undefined
      ? signal
        ? { signal }
        : undefined
      : {
          method,
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  if (response.status === 404 && path.endsWith('/status'))
    throw new ReviewerRequestError(
      'This server does not support saved agent status. Update the server before continuing.',
      false,
    );
  const result = await response.json();
  if (!response.ok)
    throw new ReviewerRequestError(
      result.error || 'Agent request failed',
      result.seatMutation === 'not-started',
    );
  return result as T;
}

/** Absence is never a proof that a lost write did not commit. Only an exact saved result releases its fence. */
function sameSnapshot(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, normalize(entry)]),
          )
        : value;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
function reconcileReviewerOperation(scope: string, status: Status) {
  const operation = reviewerOperations.snapshot()[scope];
  const mutation = operation?.uncertain;
  if (!operation || !mutation || operation.pending || status.sessionId !== operation.sessionId)
    return;
  const body = mutation.body;
  const config = status.config;
  let result: unknown;
  if (mutation.path.endsWith('/membership')) {
    const member = status.seats.find((row) => row.seatId === body.seatId)?.membership;
    if (
      !member ||
      member.sessionId !== operation.sessionId ||
      member.seatId !== body.seatId ||
      member.configRevision !== body.configRevision ||
      member.generation !== Number(body.expectedGeneration) + 1 ||
      member.idempotencyKey !== body.idempotencyKey ||
      member.action !== body.action ||
      member.reason !== body.reason ||
      member.state !== 'active' ||
      !['confirmed', 'recovery_required'].includes(member.reconciliation ?? '')
    )
      return;
    result = member;
  } else if (mutation.path.endsWith('/deliveries')) {
    const delivery = status.deliveries?.find(
      (row) =>
        row.sessionId === operation.sessionId &&
        row.sourceSeatId === body.sourceSeatId &&
        row.idempotencyKey === body.idempotencyKey &&
        row.originalContent === body.originalContent &&
        JSON.stringify(
          row.recipients?.map((recipient) => recipient.seatId) ?? row.recipientSeatIds,
        ) === JSON.stringify(body.recipientSeatIds),
    );
    if (!delivery) return;
    result = delivery;
  } else if (mutation.path.endsWith('/config')) {
    if (!config || !sameSnapshot(config, body.config)) return;
    result = config;
  } else return;
  reviewerOperations.update(scope, {
    ...operation,
    uncertain: undefined,
    committed: { ...operation.committed, [mutation.fingerprint]: result },
    seat: mutation.path.endsWith('/config')
      ? config?.seats.find((row) => row.id === operation.seatId)
      : operation.seat,
    done: mutation.path.endsWith('/deliveries'),
    notice: '',
  });
}

const ReviewerFlowContext = createContext<{
  sessionId: string;
  generic: boolean;
  open(): void;
} | null>(null);

/** Owns the form above responsive screen wrappers so viewport changes preserve retries. */
export function ReviewerSheetHost({
  sessionId,
  children,
  generic = true,
}: {
  sessionId: string;
  children: ReactNode;
  generic?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <ReviewerFlowContext.Provider
      value={{
        sessionId,
        generic,
        open: () => {
          setVisited(true);
          setOpen(true);
        },
      }}
    >
      {children}
      {visited &&
        createPortal(
          <ReviewerForm
            key={`${sessionId}:${attempt}`}
            open={open}
            generic={generic}
            sessionId={sessionId}
            onClose={() => setOpen(false)}
            onAnother={() => {
              reviewerOperations.update(reviewerOperationScope(sessionId, generic), undefined);
              setAttempt((value) => value + 1);
            }}
          />,
          document.body,
        )}
    </ReviewerFlowContext.Provider>
  );
}
export function AddReviewerSheet({ sessionId }: { sessionId: string }) {
  const flow = useContext(ReviewerFlowContext);
  if (!flow || flow.sessionId !== sessionId || flow.generic)
    return (
      <ReviewerSheetHost sessionId={sessionId} generic={false}>
        <AddReviewerSheet sessionId={sessionId} />
      </ReviewerSheetHost>
    );
  return (
    <button type="button" onClick={() => flow.open()}>
      Add reviewer
    </button>
  );
}

/** Generic conversation seat entry point; legacy reviewer callers remain supported. */
export function AddAgentSheet({ sessionId }: { sessionId: string }) {
  const flow = useContext(ReviewerFlowContext);
  if (!flow || flow.sessionId !== sessionId || !flow.generic)
    return (
      <ReviewerSheetHost sessionId={sessionId}>
        <AddAgentSheet sessionId={sessionId} />
      </ReviewerSheetHost>
    );
  return (
    <button type="button" onClick={flow.open}>
      Add agent
    </button>
  );
}

function ReviewerForm({
  sessionId,
  onClose,
  open,
  onAnother,
  generic = false,
}: {
  sessionId: string;
  onClose(): void;
  open: boolean;
  onAnother(): void;
  generic?: boolean;
}) {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/symposium`;
  const scope = reviewerOperationScope(sessionId, generic);
  const operationSnapshot = useSyncExternalStore(
    reviewerOperations.subscribe,
    reviewerOperations.snapshot,
  );
  const retained = operationSnapshot[scope];
  const approval = retained?.approval;
  const epoch = useRef(0);
  useEffect(() => {
    const lifecycle = epoch;
    lifecycle.current++;
    return () => {
      lifecycle.current++;
    };
  }, [open]);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      previous?.focus();
    };
  }, [open]);
  const [status, setStatus] = useState<Status | null>(null);
  const [selection, setSelection] = useState<AccountSelection | null>(approval?.selection ?? null);
  const [profile, setProfile] = useState<SymposiumProfileSelection | null>(
    approval?.profile ?? null,
  );
  const [name, setName] = useState(approval?.name ?? '');
  const [role, setRole] = useState(approval?.role ?? 'agent');
  const [instructions, setInstructions] = useState(approval?.instructions ?? '');
  const [expectedOutput, setExpectedOutput] = useState(approval?.expectedOutput ?? '');
  const [criteria, setCriteria] = useState(approval?.criteria ?? '');
  const [profileLoading, setProfileLoading] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showOptionalGuidance, setShowOptionalGuidance] = useState(false);
  const profileLoad = useRef(0);
  const [authority, setAuthority] = useState(
    approval?.authority ??
      ({
        filesystem: 'read',
        tools: 'read',
        network: 'restricted',
      } as {
        filesystem: 'read' | 'write';
        tools: 'read' | 'write';
        network: 'restricted';
      }),
  );
  const [mode, setMode] = useState<Mode>(approval?.mode ?? 'independent');
  const [brief, setBrief] = useState(approval?.brief ?? '');
  const [summary, setSummary] = useState(approval?.summary ?? '');
  const [turns, setTurns] = useState<{ id: string; content: string }[]>([]);
  const [turnIds, setTurnIds] = useState<string[]>(approval?.turnIds ?? []);
  const [acknowledged, setAcknowledged] = useState(approval?.acknowledged ?? false);
  const [typed, setTyped] = useState(approval?.typed ?? '');
  const [localBusy, setBusy] = useState(false);
  const busy = localBusy || retained?.pending === true;
  const [error, setError] = useState('');
  const [errorDetail, setErrorDetail] = useState('');
  const done = retained?.done ?? false;
  const [localLocked, updateLocked] = useState(false);
  const locked = localLocked || Boolean(retained);
  const lockedRef = useRef(Boolean(retained));
  const setLocked = (next: boolean) => {
    lockedRef.current = next;
    updateLocked(next);
  };
  const [progress, setProgress] = useState('');
  const packageSnapshot = useRef<{ content: string } | null>(null);
  const operation = useRef({
    seatId: `${generic ? 'agent' : 'reviewer'}-${crypto.randomUUID()}`,
    key: crypto.randomUUID(),
  });
  useEffect(() => {
    if (!open) return;
    let live = true;
    setStatus(null);
    request<Status>(`${base}/status`)
      .then((next) => {
        if (live) {
          reconcileReviewerOperation(scope, next);
          setStatus(next);
        }
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [base, open, scope]);
  useEffect(() => {
    if (mode !== 'selected-turns' && mode !== 'full-context') return;
    let live = true;
    request<{ turns: typeof turns }>(`${base}/context-turns`)
      .then((next) => {
        if (live) setTurns(next.turns);
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [base, mode]);
  const anchor = status?.config?.seats.find(
    (seat) =>
      seat.id ===
      (status.config?.version === 2 ? status.config.anchorSeatId : status.config?.seats[0]?.id),
  );
  const sourceAccountId = status?.config
    ? anchor?.accountBinding?.accountId
    : status?.ordinaryAccountId;
  const crossAccount = Boolean(
    sourceAccountId && selection?.accountId && selection.accountId !== sourceAccountId,
  );
  const ready = Boolean(
    status &&
    sourceAccountId &&
    (!status.config || canRequestRuntime(status)) &&
    (generic
      ? name.trim() &&
        /^[a-z][a-z0-9_-]{0,63}$/.test(role) &&
        instructions.trim() &&
        !profileLoading
      : profile) &&
    selection?.accountId &&
    brief.trim() &&
    acknowledged &&
    (!crossAccount || typed === confirmation) &&
    (mode !== 'summary' || summary.trim()) &&
    (mode !== 'selected-turns' || turnIds.length),
  );
  async function add() {
    const liveOperation = reviewerOperations.snapshot()[scope];
    if (
      !ready ||
      !selection ||
      (!generic && !profile) ||
      busy ||
      liveOperation?.pending ||
      liveOperation?.uncertain ||
      liveOperation?.done
    )
      return;
    const capturedEpoch = epoch.current;
    const assertCurrent = () => {
      if (epoch.current !== capturedEpoch)
        throw new Error(
          'Agent setup stopped after navigation. Check the saved operation before explicitly continuing.',
        );
    };
    const approved: ReviewerApproval =
      liveOperation?.approval ??
      structuredClone({
        selection,
        profile,
        name,
        role,
        instructions,
        expectedOutput,
        criteria,
        authority,
        mode,
        brief,
        summary,
        turnIds,
        acknowledged,
        typed,
      });
    const saved: ReviewerOperation = liveOperation
      ? structuredClone(liveOperation)
      : {
          sessionId,
          generic,
          ...operation.current,
          approval: approved,
          pending: false,
          committed: {},
          done: false,
          notice: '',
        };
    saved.pending = true;
    const publish = () => {
      const latest = reviewerOperations.snapshot()[scope];
      if (latest?.key === saved.key) reviewerOperations.update(scope, structuredClone(saved));
    };
    reviewerOperations.update(scope, structuredClone(saved));
    const {
      selection: selected,
      profile: selectedProfileBinding,
      name: approvedName,
      role: approvedRole,
      instructions: approvedInstructions,
      expectedOutput: approvedOutput,
      criteria: approvedCriteria,
      authority: approvedAuthority,
      mode: approvedMode,
      brief: approvedBrief,
      summary: approvedSummary,
      turnIds: approvedTurnIds,
      typed: approvedTyped,
    } = approved;
    const perform = async <T,>(path: string, body?: unknown, method = 'POST'): Promise<T> => {
      assertCurrent();
      const mutating =
        body !== undefined &&
        /\/(draft|config|seats\/revise|activate|admissions\/refresh|membership|deliveries)$/.test(
          path,
        );
      const fingerprint = JSON.stringify([path, body, method]);
      if (mutating && fingerprint in saved.committed) return saved.committed[fingerprint] as T;
      if (
        mutating &&
        Object.keys(saved.committed).some((previous) => {
          const [previousPath, previousBody] = JSON.parse(previous) as [
            string,
            Record<string, unknown>,
          ];
          return (
            previousPath === path &&
            (path.endsWith('/membership')
              ? previousBody.seatId === (body as Record<string, unknown>).seatId
              : true)
          );
        })
      )
        throw new Error(
          'The saved stage payload differs from current status. Check its original outcome before continuing.',
        );
      if (mutating) {
        saved.uncertain = {
          path,
          body: structuredClone(body) as Record<string, unknown>,
          method,
          fingerprint,
        };
        publish();
      }
      try {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: T;
        try {
          result = await Promise.race([
            request<T>(path, body, method, controller.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  reject(
                    new Error(
                      'Agent operation timed out. Its saved outcome must be checked before continuing.',
                    ),
                  );
                  controller.abort();
                },
                5 * 60 * 1000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (path.endsWith('/context-package')) {
          saved.context = structuredClone(result) as { content: string };
          publish();
        }
        if (mutating) {
          const payload = body as Record<string, unknown>;
          if (path.endsWith('/membership')) {
            const record = result as NonNullable<Status['seats'][number]['membership']>;
            if (
              record.sessionId !== sessionId ||
              record.seatId !== payload.seatId ||
              record.configRevision !== payload.configRevision ||
              record.idempotencyKey !== payload.idempotencyKey ||
              record.action !== payload.action ||
              record.reason !== payload.reason ||
              record.generation !== Number(payload.expectedGeneration) + 1 ||
              record.state !== 'active' ||
              record.reconciliation !== 'confirmed'
            )
              throw new Error('Agent admission outcome requires exact saved confirmation.');
          }
          if (path.endsWith('/deliveries')) {
            const record = result as NonNullable<Status['deliveries']>[number];
            if (
              record.sessionId !== sessionId ||
              record.sourceSeatId !== payload.sourceSeatId ||
              record.idempotencyKey !== payload.idempotencyKey ||
              record.originalContent !== payload.originalContent ||
              !sameSnapshot(
                record.recipients?.map((row) => row.seatId) ?? record.recipientSeatIds,
                payload.recipientSeatIds,
              )
            )
              throw new Error('Message outcome requires exact saved confirmation.');
          }
          if (/\/(config|seats\/revise|activate)$/.test(path)) {
            const confirmedConfig = result as SymposiumConfig;
            if (
              confirmedConfig.version !== 2 ||
              confirmedConfig.revision !== Number(payload.expectedRevision) + 1 ||
              (path.endsWith('/config')
                ? !sameSnapshot(confirmedConfig, payload.config)
                : confirmedConfig.state !== 'active')
            )
              throw new Error('Configuration outcome requires the exact saved revision.');
            const seat = (result as SymposiumConfig).seats?.find((row) => row.id === saved.seatId);
            if (!seat) throw new Error('Saved configuration did not confirm the approved agent.');
            if (
              seat.accountBinding?.accountId !== selected.accountId ||
              seat.model !== selected.model ||
              (seat.reasoningEffort ?? '') !== (selected.reasoningEffort ?? '') ||
              seat.color !== '#665599'
            )
              throw new Error('Configuration did not confirm the approved account and model.');
            if (generic) {
              if (
                seat.name !== approvedName.trim() ||
                seat.role !== approvedRole ||
                seat.systemPrompt !== approvedInstructions.trim() ||
                (seat.expectedOutput ?? '') !== approvedOutput.trim() ||
                !sameSnapshot(
                  seat.acceptanceCriteria ?? [],
                  approvedCriteria
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean),
                ) ||
                !sameSnapshot(seat.authorityRequest, approvedAuthority)
              )
                throw new Error(
                  'Configuration did not confirm the approved agent guidance and authority.',
                );
            } else if (
              !path.endsWith('/config') &&
              (seat.role !== 'reviewer' ||
                seat.profileBinding?.profileId !== selectedProfileBinding?.profileId ||
                seat.profileBinding?.profileRevision !== String(selectedProfileBinding?.revision))
            )
              throw new Error('Configuration did not confirm the approved reviewer profile.');
            saved.seat = structuredClone(seat);
          }
          saved.committed[fingerprint] = structuredClone(result);
          saved.uncertain = undefined;
          publish();
        }
        assertCurrent();
        return result;
      } catch (cause) {
        if (
          mutating &&
          cause instanceof ReviewerRequestError &&
          cause.noSeatMutation &&
          /\/(config|seats\/revise)$/.test(path)
        ) {
          saved.uncertain = undefined;
          publish();
        }
        throw cause;
      }
    };
    setBusy(true);
    setProgress('Preparing the agent and its message context…');
    setError('');
    setErrorDetail('');
    let reviewerMutationAttempted = false;

    try {
      const selectedProfile =
        !generic && selectedProfileBinding
          ? await perform<{ definition: { role: string } }>(
              `/api/symposium/profiles/${encodeURIComponent(selectedProfileBinding!.profileId)}/${selectedProfileBinding!.revision}`,
            )
          : null;
      if (!generic && selectedProfile?.definition?.role !== 'reviewer')
        throw new Error('Choose a profile with the reviewer role.');
      const context =
        saved.context ??
        (await perform<{ content: string }>(`${base}/context-package`, {
          mode: approvedMode,
          ...(approvedMode === 'summary' ? { summary: approvedSummary } : {}),
          ...(approvedMode === 'selected-turns' ? { turnIds: approvedTurnIds } : {}),
        }));
      let current = await perform<Status>(`${base}/status`);
      let config = current.config;
      if (!config) {
        setStatus(current);
        if (!current.ordinaryAccountId)
          throw new Error('Conversation account binding is unavailable');
        if (current.ordinaryAccountId !== selected.accountId && approvedTyped !== confirmation)
          throw new Error('Confirm the cross-account transfer before binding the agent');
        config = await perform<SymposiumConfig>(`${base}/draft`, {
          expectedAccountId: current.ordinaryAccountId,
        });
      }
      if (config.version !== 2)
        throw new Error('This roster must be upgraded before adding an agent');
      const configuredAnchorId = config.anchorSeatId;
      const configuredAnchor = config.seats.find((seat) => seat.id === configuredAnchorId);
      if (
        configuredAnchor?.accountBinding &&
        configuredAnchor.accountBinding.accountId !== selected.accountId &&
        approvedTyped !== confirmation
      )
        throw new Error('Confirm the cross-account transfer before binding the agent');
      saved.context = context;
      publish();
      setLocked(true);
      const boundary = {
        sharedBoundaryAcknowledged: true,
        ...(approvedTyped === confirmation ? { crossAccountConfirmation: confirmation } : {}),
      };
      const seatId = saved.seatId;
      const guidance = generic
        ? {
            name: approvedName.trim(),
            role: approvedRole,
            systemPrompt: approvedInstructions.trim(),
            ...(approvedOutput.trim() ? { expectedOutput: approvedOutput.trim() } : {}),
            ...(approvedCriteria.trim()
              ? {
                  acceptanceCriteria: approvedCriteria
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean),
                }
              : {}),
            authorityRequest: approvedAuthority,
          }
        : { name: 'Reviewer', role: 'reviewer', systemPrompt: '' };
      const existing = config.seats.find((seat) => seat.id === seatId);
      if (existing && (!saved.seat || !sameSnapshot(existing, saved.seat)))
        throw new Error(
          'The saved agent configuration changed. Check the original operation before continuing.',
        );
      reviewerMutationAttempted = config.seats.some((seat) => seat.id === seatId);
      if (!reviewerMutationAttempted) {
        if (config.state === 'active') {
          reviewerMutationAttempted = true;
          config = await perform<SymposiumConfig>(`${base}/seats/revise`, {
            expectedRevision: config.revision,
            seatId,
            ...guidance,
            color: '#665599',
            accountId: selected.accountId,
            model: selected.model,
            ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
            ...(!generic && selectedProfileBinding
              ? { profileSelection: selectedProfileBinding }
              : {}),
            contextSourceRefs: [],
            ...boundary,
          });
        } else {
          const { binding } = await perform<{ binding: ValidAccountBinding }>(`${base}/selection`, {
            accountId: selected.accountId,
            model: selected.model,
            ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
          });
          reviewerMutationAttempted = true;
          config = await perform<SymposiumConfig>(
            `${base}/config`,
            {
              expectedRevision: config.revision,
              config: {
                ...config,
                revision: config.revision + 1,
                seats: [
                  ...config.seats,
                  {
                    id: seatId,
                    ...guidance,
                    color: '#665599',
                    model: selected.model,
                    accountBinding: binding,
                    ...(selected.reasoningEffort
                      ? { reasoningEffort: selected.reasoningEffort }
                      : {}),
                  },
                ],
              },
            },
            'PUT',
          );
        }
      }
      setProgress(`${generic ? 'Agent' : 'Reviewer'} configured. Checking its connection…`);
      if (config.state === 'draft')
        config = await perform<SymposiumConfig>(`${base}/activate`, {
          expectedRevision: config.revision,
          contextSourceRefs: [],
          profileSelections: {
            ...current.initialProfileSelections,
            ...(!generic && selectedProfileBinding ? { [seatId]: selectedProfileBinding } : {}),
          },
          ...boundary,
        });
      setProgress(
        'Connecting agent — checking its account and workspace access. This may take several minutes.',
      );
      await perform(`${base}/admissions/refresh`, { expectedRevision: config.revision });
      current = await perform<Status>(`${base}/status`);
      const currentSeat = current.config?.seats.find((seat) => seat.id === seatId);
      if (!saved.seat || !sameSnapshot(currentSeat, saved.seat))
        throw new Error('The saved agent configuration changed before admission.');
      // Existing isolated sessions stay isolated; new anchors are admitted through the same host boundary.
      for (const id of [config.version === 2 ? config.anchorSeatId : config.seats[0].id, seatId]) {
        const membership = current.seats.find((seat) => seat.seatId === id)?.membership;
        if (membership?.reconciliation === 'recovery_required')
          throw new Error('Saved admission requires host recovery before continuing.');
        if (membership?.state === 'active') continue;
        await perform(`${base}/membership`, {
          seatId: id,
          action: membership?.state === 'suspended' ? 'restore' : 'admit',
          expectedGeneration: membership?.generation ?? 0,
          configRevision: config.revision,
          reason: generic ? 'Add agent' : 'Add reviewer',
          idempotencyKey: `${saved.key}:${id}`,
          ...boundary,
        });
      }
      setProgress(
        `${generic ? 'Agent' : 'Reviewer'} setup completed. Requesting message approval…`,
      );

      await perform(`${base}/deliveries`, {
        sourceSeatId: null,
        recipientSeatIds: [seatId],
        originalContent: `${generic ? 'Agent request:' : 'Review request (read-only):'}\n${approvedBrief.trim()}${context.content ? `\n\n${context.content}` : ''}`,
        idempotencyKey: `${saved.key}:context`,
      });
      saved.done = true;
      saved.notice = '';
      publish();
      window.dispatchEvent(new Event('symposium-roster-changed'));
    } catch (cause) {
      saved.notice = cause instanceof Error ? cause.message : 'Agent request failed';
      publish();
      if (epoch.current === capturedEpoch) {
        setErrorDetail(saved.notice);
        setError(
          cause instanceof ReviewerRequestError &&
            cause.noSeatMutation &&
            !saved.uncertain &&
            Object.keys(saved.committed).length === 0
            ? 'Couldn’t connect this agent. Your choices are still in this form; no message was sent.'
            : 'The request couldn’t be completed. Check the saved operation before explicitly continuing.',
        );
        const refreshed = await request<Status>(`${base}/status`).catch(() => null);
        if (epoch.current === capturedEpoch && refreshed) {
          reconcileReviewerOperation(scope, refreshed);
          setStatus(refreshed);
        }
        if (
          (!reviewerMutationAttempted ||
            (cause instanceof ReviewerRequestError && cause.noSeatMutation)) &&
          !saved.uncertain &&
          Object.keys(saved.committed).length === 0
        ) {
          reviewerOperations.update(scope, undefined);
          setLocked(false);
          packageSnapshot.current = null;
        }
      }
    } finally {
      const latest = reviewerOperations.snapshot()[scope];
      if (latest?.key === saved.key)
        reviewerOperations.update(scope, { ...latest, pending: false });
      if (epoch.current === capturedEpoch) setBusy(false);
    }
  }

  return (
    <div
      className="reviewer-sheet-backdrop"
      hidden={!open}
      style={{ display: open ? undefined : 'none' }}
    >
      <section
        ref={dialog}
        className="reviewer-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={generic ? 'Add agent' : 'Ask another agent'}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) onClose();
          if (event.key === 'Tab') {
            const controls = [
              ...(dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary',
              ) ?? []),
            ].filter(
              (node) =>
                !node.hidden &&
                (!node.closest('details:not([open])') || node.tagName === 'SUMMARY'),
            );
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>{generic ? 'Add agent' : 'Ask another agent'}</h2>
          <button type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
        </header>
        {done ? (
          <>
            <p role="status">
              {generic
                ? 'Agent added. The selected context is queued. Approve and send it in the conversation.'
                : 'Reviewer added. The selected context is queued for approval in Director controls.'}
            </p>
            <button type="button" onClick={onClose}>
              Done
            </button>
            <button type="button" onClick={onAnother}>
              {generic ? 'Add another agent' : 'Add another reviewer'}
            </button>
          </>
        ) : (
          <>
            <p>
              {generic
                ? 'Give this agent a name and tell it what to do.'
                : 'Choose a saved profile and the account that will receive this review request.'}
            </p>
            <fieldset disabled={busy || locked}>
              {generic && <h3>Guidance</h3>}
              {generic && (
                <>
                  <fieldset disabled={profileLoading}>
                    <label>
                      Agent name
                      <input value={name} onChange={(event) => setName(event.target.value)} />
                    </label>
                    <label>
                      Agent instructions
                      <textarea
                        value={instructions}
                        onChange={(event) => setInstructions(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      aria-expanded={showOptionalGuidance}
                      onClick={() => setShowOptionalGuidance(!showOptionalGuidance)}
                    >
                      Output and advanced guidance (optional)
                    </button>
                    {showOptionalGuidance && (
                      <div>
                        <label>
                          Agent role
                          <input
                            value={role}
                            onChange={(event) => setRole(event.target.value)}
                            pattern="[a-z][a-z0-9_-]{0,63}"
                          />
                        </label>
                        <label>
                          Agent expected output
                          <textarea
                            value={expectedOutput}
                            onChange={(event) => setExpectedOutput(event.target.value)}
                          />
                        </label>
                        <label>
                          Agent acceptance criteria
                          <textarea
                            value={criteria}
                            onChange={(event) => setCriteria(event.target.value)}
                            placeholder="One criterion per line"
                          />
                        </label>
                      </div>
                    )}
                  </fieldset>
                  {profileLoading && <p role="status">Loading saved guidance…</p>}
                </>
              )}
              {generic && (
                <button
                  type="button"
                  aria-expanded={showProfile}
                  onClick={() => setShowProfile(!showProfile)}
                >
                  Use a saved profile
                </button>
              )}
              {(!generic || showProfile) && (
                <div>
                  {generic && <p>Copy saved guidance, then adjust it for this agent.</p>}
                  <SymposiumProfilePicker
                    compact
                    requiredRole={generic ? undefined : 'reviewer'}
                    value={profile}
                    onChange={(next) => {
                      if (lockedRef.current) return;
                      setProfile(next);
                      if (!generic) return;
                      setError('');
                      const load = ++profileLoad.current;
                      setProfileLoading(Boolean(next));
                      if (!next) return;
                      void request<{ definition: SymposiumProfileDefinition }>(
                        `/api/symposium/profiles/${encodeURIComponent(next.profileId)}/${next.revision}`,
                      )
                        .then(({ definition }) => {
                          if (load !== profileLoad.current || lockedRef.current) return;
                          setName(definition.name);
                          setRole(definition.role);
                          setInstructions(definition.instructions);
                          setExpectedOutput(definition.expectedOutput);
                          setCriteria(definition.acceptanceCriteria.join('\n'));
                          // This is a local copy. Catalog identity cannot overwrite custom seat guidance.
                        })
                        .catch((cause: Error) => {
                          if (load !== profileLoad.current || lockedRef.current) return;
                          setProfile(null);
                          setError(
                            `Could not load saved profile: ${cause.message}. Existing custom guidance was kept; choose a profile again or continue with these custom fields.`,
                          );
                        })
                        .finally(() => {
                          if (load === profileLoad.current) setProfileLoading(false);
                        });
                    }}
                    disabled={busy || locked}
                  />
                </div>
              )}
              {generic && <h3>Account and model</h3>}
              <AccountModelPicker
                scope="symposium"
                requireExplicitSelection
                sessionId={null}
                preferredModel=""
                onChange={(next) => {
                  if (!lockedRef.current) setSelection(next);
                }}
                disabled={busy || locked}
              />
              {generic && (
                <>
                  <h3>Access</h3>
                  <label>
                    Agent permissions
                    <select
                      value={authority.filesystem}
                      onChange={(event) => {
                        const permission = event.target.value as 'read' | 'write';
                        setAuthority({
                          filesystem: permission,
                          tools: permission,
                          network: 'restricted',
                        });
                      }}
                    >
                      <option value="read">Read-only workspace and tools</option>
                      <option value="write">Read and write workspace and tools</option>
                    </select>
                  </label>
                  <p>Read-only is the default. Network access is restricted.</p>
                </>
              )}
              {generic && (
                <>
                  <h3>Message and context</h3>
                  <p>
                    Recipient: <strong>{name.trim() || 'Your new agent'}</strong>
                  </p>
                </>
              )}
              <label>
                {generic ? 'Initial message' : 'Review package'}
                <textarea
                  value={brief}
                  onChange={(event) => setBrief(event.target.value)}
                  placeholder="Describe the task and include only the material this agent should receive."
                />
              </label>
              <label>
                Context package
                <select
                  value={mode}
                  onChange={(event) => {
                    setMode(event.target.value as Mode);
                    setError('');
                  }}
                >
                  <option value="independent">Independent — initial message only</option>
                  <option value="summary">Summary — written by you</option>
                  <option value="selected-turns">Selected shared turns</option>
                  <option value="full-context">
                    Full shared context — excludes private asides
                  </option>
                </select>
              </label>
              {mode === 'summary' && (
                <label>
                  Summary to share
                  <textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
                </label>
              )}
              {mode === 'selected-turns' &&
                turns.map((turn) => (
                  <label key={turn.id}>
                    <input
                      type="checkbox"
                      checked={turnIds.includes(turn.id)}
                      onChange={(event) =>
                        setTurnIds((ids) =>
                          event.target.checked
                            ? [...ids, turn.id]
                            : ids.filter((id) => id !== turn.id),
                        )
                      }
                    />
                    {turn.content}
                  </label>
                ))}
              {mode === 'full-context' && (
                <p>
                  {turns.length} delivered broadcast excerpts. Private asides, queued inputs and
                  legacy turns without audience proof are excluded.
                </p>
              )}
              <p>
                Only this agent receives the message and selected context after you approve sending.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  I understand this agent can access shared files within its permissions, and its
                  provider account may retain the message and chosen context.
                </span>
              </label>
              {crossAccount && (
                <label>
                  Cross-account confirmation
                  <input
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    placeholder={confirmation}
                  />
                  <span>Required if this account differs from the conversation account.</span>
                </label>
              )}
            </fieldset>
            {(!status || !canRequestRuntime(status)) && (
              <p role="status">
                {status?.config
                  ? 'This agent can’t connect yet. Your choices stay in this form.'
                  : 'Checking whether this chat can add an agent…'}
              </p>
            )}
            {progress && <p role="status">{progress}</p>}
            {retained && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const checkedEpoch = epoch.current;
                  const checkedKey = retained.key;
                  void request<Status>(`${base}/status`)
                    .then((next) => {
                      if (
                        epoch.current !== checkedEpoch ||
                        reviewerOperations.snapshot()[scope]?.key !== checkedKey
                      )
                        return;
                      reconcileReviewerOperation(scope, next);
                      setStatus(next);
                    })
                    .catch((cause) => {
                      if (
                        epoch.current === checkedEpoch &&
                        reviewerOperations.snapshot()[scope]?.key === checkedKey
                      )
                        setError(
                          String(cause instanceof Error ? cause.message : 'Status unavailable'),
                        );
                    });
                }}
              >
                Check saved operation
              </button>
            )}
            <button
              className="btn-primary"
              type="button"
              disabled={!ready || busy || Boolean(retained?.uncertain)}
              onClick={() => void add()}
            >
              {busy
                ? 'Connecting agent…'
                : generic
                  ? 'Add agent and queue message'
                  : 'Add reviewer and queue context'}
            </button>
            {(error || retained?.notice) && (
              <div role="alert">
                <p>{error || retained?.notice}</p>
                {errorDetail && (
                  <details>
                    <summary>Technical details</summary>
                    <p>{errorDetail}</p>
                  </details>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
