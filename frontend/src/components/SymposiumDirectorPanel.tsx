import './SymposiumDirectorPanel.css';
import { canRequestAgent, canRequestRuntime } from '../lib/symposium-status';
import { SeatLabel } from './SeatLabel';
import { SymposiumSourceImportPanel } from './SymposiumSourceImportPanel';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  canonicalConfigurationOperationJson,
  SymposiumConfigurationOperationReceiptSchema,
} from '@mitzo/protocol';
import type {
  SeatConfig,
  SymposiumConfig,
  SymposiumDeliveryRecord,
  SymposiumMembershipRecord,
  SymposiumAdmissionRecord,
  ValidAccountBinding,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { AccountModelPicker, type AccountSelection } from './AccountModelPicker';
import { SymposiumProfilePicker, type SymposiumProfileSelection } from './SymposiumProfilePicker';

type EnableAction = {
  pending: boolean;
  notice: string;
  revision: number;
  activation?: {
    sessionId: string;
    idempotencyKey: string;
    request: Record<string, unknown>;
    draft: Extract<SymposiumConfig, { version: 2 }>;
    orderedSeatIds: string[];
    completedSeatIds: string[];
    activated?: SymposiumConfig;
    recovered: boolean;
  };
  uncertainAdmission?: {
    sessionId: string;
    seatId: string;
    configRevision: number;
    expectedGeneration: number;
    idempotencyKey: string;
  };
};
// Like delivery action fences, this survives keyed navigation within the page.
// A lost activation response must never cause a new activation on remount.
let enableActions: Record<string, EnableAction> = {};
const enableListeners = new Set<() => void>();
const enableActionStore = {
  snapshot: () => enableActions,
  subscribe: (listener: () => void) => {
    enableListeners.add(listener);
    return () => {
      enableListeners.delete(listener);
    };
  },
  update: (change: (old: typeof enableActions) => typeof enableActions) => {
    enableActions = change(enableActions);
    enableListeners.forEach((listener) => listener());
  },
};
// eslint-disable-next-line react-refresh/only-export-components -- Shared page-lifetime fence, exposed for remount contract tests.
export const getSymposiumEnableActions = () => enableActionStore;
const enableRequestDeadlineMs = 5 * 60 * 1000;
function immutableEnableSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry && typeof entry === 'object') {
      Object.values(entry).forEach(freeze);
      Object.freeze(entry);
    }
  };
  freeze(snapshot);
  return snapshot;
}

async function readEnableJson<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readJson<T>(path, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              'The connection check timed out. Its host outcome may still be pending. Check status before taking another action.',
            ),
          );
          controller.abort();
        }, enableRequestDeadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function AdvancedControls({
  label,
  children,
  onOpen,
  revealKey,
}: {
  label: string;
  children: ReactNode;
  onOpen?: () => void;
  revealKey?: number;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (revealKey) setOpen(true);
  }, [revealKey]);
  return (
    <div className="symposium-advanced-controls">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {label}
      </button>
      {open && <div className="symposium-advanced-content">{children}</div>}
    </div>
  );
}

interface DirectorSeat {
  seatId: string;
  seat: SeatConfig;
  membership: SymposiumMembershipRecord | null;
  admitted: boolean;
  admissionRecorded?: boolean;
  savedRuntimeState?: string | null;
  creationDiagnostic?: {
    phase: string;
    code: string;
    canCleanup: boolean;
    recoveryIdempotencyKey?: string;
    recoveryAuthorization?: {
      operationId: string;
      revision: number;
      state: 'reauthorization_required' | 'cleanup_fenced' | 'authorized';
    };
  } | null;
  admission?: Pick<
    SymposiumAdmissionRecord,
    'configRevision' | 'membershipGeneration' | 'decision'
  > | null;
}
interface DirectorStatus {
  sessionId: string;
  config: SymposiumConfig | null;
  seats: DirectorSeat[];
  runtimeAvailable: boolean;
  statusMode?: string;
  runtimeVerification?: string;
  profileBindingEnforced?: boolean;
  initialProfileSelections?: Record<string, SymposiumProfileSelection>;
  reservedSeats: number;
  capacityRemaining: number;
  deliveries: SymposiumDeliveryRecord[];
}

function resolveInitialAdmission(base: string, status: DirectorStatus) {
  const action = enableActions[base];
  const uncertain = action?.uncertainAdmission;
  if (
    !uncertain ||
    status.sessionId !== uncertain.sessionId ||
    status.config?.revision !== uncertain.configRevision ||
    status.config.state !== 'active'
  )
    return;
  const member = status.seats.find((seat) => seat.seatId === uncertain.seatId)?.membership;
  if (
    !member ||
    member.sessionId !== status.sessionId ||
    member.seatId !== uncertain.seatId ||
    member.configRevision !== uncertain.configRevision ||
    member.generation !== uncertain.expectedGeneration + 1 ||
    member.idempotencyKey !== uncertain.idempotencyKey ||
    member.action !== 'admit' ||
    member.reason !== 'Initial enablement by director' ||
    member.state !== 'active' ||
    !['confirmed', 'recovery_required'].includes(member.reconciliation)
  )
    return;
  enableActionStore.update((old) => ({
    ...old,
    [base]: { ...old[base], uncertainAdmission: undefined },
  }));
}

const confirmation = 'ADD CROSS-ACCOUNT SEAT';
const jsonHeaders = { 'Content-Type': 'application/json' };

function crossesAnchorAccount(config: SymposiumConfig): boolean {
  const anchor =
    config.version === 2
      ? config.seats.find((seat) => seat.id === config.anchorSeatId)
      : config.seats[0];
  return Boolean(
    anchor?.accountBinding &&
    config.seats.some(
      (seat) =>
        seat.accountBinding && seat.accountBinding.accountId !== anchor.accountBinding?.accountId,
    ),
  );
}

function anchorAccountId(config: SymposiumConfig): string | undefined {
  const anchor =
    config.version === 2
      ? config.seats.find((seat) => seat.id === config.anchorSeatId)
      : config.seats[0];
  return anchor?.accountBinding?.accountId;
}

class ActivationNotStartedError extends Error {}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (response.status === 404 && path.endsWith('/status'))
    throw new Error(
      'This server does not support saved agent status. Update the server before continuing.',
    );
  const body = (await response.json()) as T & { error?: string; activationMutation?: string };
  if (!response.ok) {
    const message = body.error || `Request failed (${response.status})`;
    if (
      /^\/api\/sessions\/[^/]+\/symposium\/activate$/.test(path) &&
      body.activationMutation === 'not-started'
    )
      throw new ActivationNotStartedError(message);
    throw new Error(message);
  }
  return body;
}

function CreationRecoveryAuthorization({
  sessionId,
  seat,
  revision,
  onSaved,
}: {
  sessionId: string;
  seat: DirectorSeat;
  revision: number;
  onSaved: () => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const key = useRef(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function authorize() {
    if (busy || !passphrase || typed !== 'RESUME FAILED SEAT CLEANUP') return;
    const secret = passphrase;
    setPassphrase('');
    setTyped('');
    setBusy(true);
    setError('');
    try {
      const auth = await readJson<{ csrf: string; expiresAt: number }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/symposium/creation/recovery/app-reauthorize`,
        {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ passphrase: secret }),
        },
      );
      if (!active.current) return;
      if (!auth.csrf || !Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now())
        throw new Error('Recent app authorization expired. Enter the passphrase again.');
      const operation = seat.creationDiagnostic!.recoveryAuthorization!;
      await readJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/symposium/creation/recovery/reauthorize`,
        {
          method: 'POST',
          headers: { ...jsonHeaders, 'x-csrf-token': auth.csrf },
          body: JSON.stringify({
            seatId: seat.seatId,
            expectedRevision: revision,
            expectedGeneration: seat.membership!.generation,
            operationId: operation.operationId,
            expectedAuthorizationRevision: operation.revision,
            idempotencyKey: key.current,
            confirmation: 'RESUME FAILED SEAT CLEANUP',
          }),
        },
      );
      if (active.current) await onSaved();
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : 'Cleanup authorization failed');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <fieldset disabled={busy}>
      <p>
        Fresh app reauthorization is required to resume this pending cleanup. Authorization only
        transfers this operation; cleanup requires a separate action.
      </p>
      <label>
        App passphrase for {seat.seat.name} cleanup
        <input
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
        />
      </label>
      <label>
        Type RESUME FAILED SEAT CLEANUP for {seat.seat.name}
        <input value={typed} onChange={(event) => setTyped(event.target.value)} />
      </label>
      <button
        type="button"
        disabled={busy || !passphrase || typed !== 'RESUME FAILED SEAT CLEANUP'}
        onClick={() => void authorize()}
      >
        {busy ? 'Authorizing…' : 'Authorize pending cleanup'}
      </button>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}

function SeatModelEditor({
  sessionId,
  seat,
  config,
  profileSelection,
  onSaved,
}: {
  sessionId: string;
  seat: DirectorSeat;
  config: SymposiumConfig;
  profileSelection: SymposiumProfileSelection | null;
  onSaved: () => Promise<void>;
}) {
  const [selection, setSelection] = useState<AccountSelection | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [boundaryAcknowledged, setBoundaryAcknowledged] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const active = seat.membership?.state === 'active';
  const anchor =
    config.version === 2 ? seat.seatId === config.anchorSeatId : seat.seatId === config.seats[0].id;
  async function save() {
    if (!selection?.accountId || saving) return;
    setSaving(true);
    setError('');
    try {
      const base = `/api/sessions/${encodeURIComponent(sessionId)}/symposium`;
      if (config.state === 'active') {
        await readJson(`${base}/seats/revise`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            expectedRevision: config.revision,
            seatId: seat.seatId,
            name: seat.seat.name,
            role: seat.seat.role,
            systemPrompt: seat.seat.systemPrompt,
            ...(seat.seat.authorityRequest ? { authorityRequest: seat.seat.authorityRequest } : {}),
            ...(seat.seat.expectedOutput !== undefined
              ? { expectedOutput: seat.seat.expectedOutput }
              : {}),
            ...(seat.seat.acceptanceCriteria !== undefined
              ? { acceptanceCriteria: seat.seat.acceptanceCriteria }
              : {}),
            color: seat.seat.color,
            accountId: selection.accountId,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
            ...(profileSelection ? { profileSelection } : {}),
            sharedBoundaryAcknowledged: boundaryAcknowledged,
            ...(typedConfirmation === confirmation
              ? { crossAccountConfirmation: confirmation }
              : {}),
          }),
        });
        await onSaved();
        return;
      }
      const { binding } = await readJson<{ binding: ValidAccountBinding }>(`${base}/selection`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          accountId: selection.accountId,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        }),
      });
      const seats = config.seats.map((candidate) =>
        candidate.id === seat.seatId
          ? {
              ...candidate,
              model: selection.model,
              accountBinding: binding,
              reasoningEffort: selection.reasoningEffort || undefined,
            }
          : candidate,
      );
      const next = { ...config, revision: config.revision + 1, seats };
      await readJson(`${base}/config`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({
          expectedRevision: config.revision,
          config: next,
        }),
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Seat selection failed');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="symposium-seat-selection">
      <AccountModelPicker
        scope="symposium"
        sessionId={null}
        preferredModel={seat.seat.model}
        onChange={setSelection}
        disabled={active || anchor || saving}
      />
      {config.state === 'active' && (
        <label>
          <input
            type="checkbox"
            checked={boundaryAcknowledged}
            onChange={(event) => setBoundaryAcknowledged(event.target.checked)}
          />
          <span>
            I understand this agent can access shared files within its permissions, and its provider
            account may retain messages.
          </span>
        </label>
      )}
      {selection?.accountId && selection.accountId !== anchorAccountId(config) && (
        <label>
          Cross-account confirmation{' '}
          <input
            value={typedConfirmation}
            onChange={(event) => setTypedConfirmation(event.target.value)}
            placeholder={confirmation}
          />
        </label>
      )}
      <button
        type="button"
        disabled={
          active ||
          anchor ||
          saving ||
          !selection?.accountId ||
          (config.state === 'active' && !boundaryAcknowledged)
        }
        onClick={() => void save()}
      >
        Save account and model
      </button>
      {active && <span>Suspend this seat before changing its account or model.</span>}
      {anchor && <span>The anchor keeps this conversation's account binding.</span>}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function SymposiumDirectorPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  // Keep visibility across navigation, but isolate all roster, form, and request state.
  return (
    <SessionDirectorPanel key={sessionId} sessionId={sessionId} open={open} setOpen={setOpen} />
  );
}

function SessionDirectorPanel({
  sessionId,
  open,
  setOpen,
}: {
  sessionId: string;
  open: boolean;
  setOpen: (value: (current: boolean) => boolean) => void;
}) {
  const [status, setStatus] = useState<DirectorStatus | null>(null);
  const [artifactMessage, setArtifactMessage] = useState('');
  const [detailChecks, setDetailChecks] = useState<
    Record<string, { pending: boolean; error?: string }>
  >({});
  const [loading, setLoading] = useState(false);
  const [localBusy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [reviewHandoff, setReviewHandoff] = useState(0);
  const [editContent, setEditContent] = useState('');
  const [primarySelection, setPrimarySelection] = useState('');
  const [primaryConfirmation, setPrimaryConfirmation] = useState('');
  const [cleanupConfirmation, setCleanupConfirmation] = useState<Record<string, string>>({});
  const [newSeatId, setNewSeatId] = useState('');
  const [newSeatName, setNewSeatName] = useState('');
  const [newSeatRole, setNewSeatRole] = useState('implementer');
  const [newSeatSelection, setNewSeatSelection] = useState<AccountSelection | null>(null);
  const [profileSelections, setProfileSelections] = useState<
    Record<string, SymposiumProfileSelection>
  >({});
  const [newSeatProfile, setNewSeatProfile] = useState<SymposiumProfileSelection | null>(null);
  const [boundaryAcknowledged, setBoundaryAcknowledged] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const pendingKeys = useRef(new Map<string, string>());
  const refreshGeneration = useRef(0);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/symposium`;
  const actionSnapshot = useSyncExternalStore(
    enableActionStore.subscribe,
    enableActionStore.snapshot,
  );
  const enableAction = actionSnapshot[base];
  const busy =
    localBusy || enableAction?.pending === true || Boolean(enableAction?.uncertainAdmission);
  const lifecycle = useRef(0);
  const enableLock = useRef(false);
  useEffect(() => {
    lifecycle.current++;
    const ownedLifecycle = lifecycle;
    return () => {
      ownedLifecycle.current++;
    };
  }, [open]);

  const refresh = useCallback(
    async (preservedError?: string) => {
      const generation = ++refreshGeneration.current;
      setLoading(true);
      setDetailChecks({});
      setCleanupConfirmation({});
      try {
        const next = await readJson<DirectorStatus>(`${base}/status`);
        if (generation !== refreshGeneration.current) return;
        resolveInitialAdmission(base, next);
        setStatus(next);
        setDetailChecks({});
        // Typed cleanup consent belongs to the status the operator inspected.
        setCleanupConfirmation({});
        setProfileSelections((current) => ({ ...next.initialProfileSelections, ...current }));
        setSelected((current) =>
          current.filter((id) =>
            next.seats.some((seat) => seat.seatId === id && canRequestAgent(seat)),
          ),
        );
        setError(preservedError ?? '');
      } catch (cause) {
        if (generation === refreshGeneration.current) {
          const refreshError =
            cause instanceof Error ? cause.message : 'Director status unavailable';
          setError(
            preservedError
              ? `${preservedError}. Status refresh failed: ${refreshError}`
              : refreshError,
          );
        }
      } finally {
        if (generation === refreshGeneration.current) setLoading(false);
      }
    },
    [base],
  );

  useEffect(() => {
    setStatus(null);
    setSelected([]);
    setPrimarySelection('');
    setPrimaryConfirmation('');
    setCleanupConfirmation({});
    setProfileSelections({});
    pendingKeys.current.clear();
    if (open) void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [sessionId, open, refresh]);

  async function checkDetails(seat: DirectorSeat) {
    if (
      status?.statusMode !== 'durable' ||
      !seat.creationDiagnostic ||
      detailChecks[seat.seatId]?.pending
    )
      return;
    const epoch = refreshGeneration.current;
    const revision = status.config?.revision;
    const generation = seat.membership?.generation;
    setDetailChecks((old) => ({ ...old, [seat.seatId]: { pending: true } }));
    setCleanupConfirmation((old) => ({ ...old, [seat.seatId]: '' }));
    try {
      const checked = await readJson<DirectorStatus>(base);
      if (epoch !== refreshGeneration.current) return;
      const exact = checked.seats.find((item) => item.seatId === seat.seatId);
      if (
        checked.sessionId !== sessionId ||
        checked.statusMode === 'durable' ||
        checked.runtimeVerification === 'not_checked' ||
        !exact ||
        checked.config?.revision !== revision ||
        exact?.membership?.generation !== generation
      )
        throw new Error('Agent details changed. Refresh the agent list before continuing.');
      if (!checked.runtimeAvailable || !exact.creationDiagnostic)
        throw new Error('Current creation proof is unavailable. The saved failure is retained.');
      setStatus(
        (current) =>
          current && {
            ...current,
            seats: current.seats.map((item) =>
              item.seatId === seat.seatId
                ? { ...item, creationDiagnostic: exact.creationDiagnostic }
                : item,
            ),
          },
      );
      setDetailChecks((old) => ({ ...old, [seat.seatId]: { pending: false } }));
    } catch (cause) {
      if (epoch !== refreshGeneration.current) return;
      setDetailChecks((old) => ({
        ...old,
        [seat.seatId]: {
          pending: false,
          error: cause instanceof Error ? cause.message : 'Could not check connection details',
        },
      }));
    }
  }

  useEffect(() => {
    const openTeam = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId !== sessionId) return;
      setReviewHandoff((current) => current + 1);
      if (open) void refresh();
      else setOpen(() => true);
    };
    window.addEventListener('symposium-open-team', openTeam);
    return () => window.removeEventListener('symposium-open-team', openTeam);
  }, [sessionId, open, refresh, setOpen]);

  async function mutate(path: string, payload: Record<string, unknown>, method = 'POST') {
    if (busy) return;
    setBusy(true);
    setError('');
    const fingerprint = JSON.stringify([path, payload]);
    let idempotencyKey =
      typeof payload.idempotencyKey === 'string'
        ? payload.idempotencyKey
        : pendingKeys.current.get(fingerprint);
    if (!idempotencyKey) {
      idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      pendingKeys.current.set(fingerprint, idempotencyKey);
    }
    try {
      await readJson(`${base}${path}`, {
        method,
        headers: jsonHeaders,
        body: JSON.stringify({ ...payload, idempotencyKey }),
      });
      pendingKeys.current.delete(fingerprint);
      if (path === '/creation/recover' && typeof payload.seatId === 'string') {
        const seatId = payload.seatId;
        setCleanupConfirmation((current) => ({ ...current, [seatId]: '' }));
      }
      if (path === '/primary/transfer') {
        setPrimarySelection('');
        setPrimaryConfirmation('');
      }
      window.dispatchEvent(new Event('symposium-roster-changed'));
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Director action failed';
      setError(message);
      // The durable transfer may have committed before retained admission failed.
      // Read its current revision before offering admission repair, preserving the error.
      if (path === '/primary/transfer' || path === '/creation/recover') await refresh(message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshAdmissions() {
    if (busy || !status?.config) return;
    setBusy(true);
    setError('');
    try {
      await readJson(`${base}/admissions/refresh`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ expectedRevision: status.config.revision }),
      });
      window.dispatchEvent(new Event('symposium-roster-changed'));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Seat admissions require recovery');
    } finally {
      setBusy(false);
    }
  }

  async function createDraft() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await readJson(`${base}/draft`, { method: 'POST', headers: jsonHeaders, body: '{}' });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create draft');
    } finally {
      setBusy(false);
    }
  }

  async function prepareArtifacts() {
    if (busy || status?.config?.state !== 'draft') return;
    setBusy(true);
    setError('');
    setArtifactMessage('');
    try {
      const result = await readJson<{ state: string }>(
        `/api/symposium/sessions/${encodeURIComponent(sessionId)}/artifacts`,
        { method: 'POST', headers: jsonHeaders, body: '{}' },
      );
      if (result.state !== 'ready')
        throw new Error(
          'Shared files are still unavailable. Your setup is saved; retry here when ready.',
        );
      await refresh();
      setArtifactMessage('Shared files are ready. Review your choices before enabling agents.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare shared files');
    } finally {
      setBusy(false);
    }
  }

  async function checkSavedActivation() {
    const saved = enableActions[base];
    const activation = saved?.activation;
    if (!activation || saved.pending || enableLock.current || localBusy) return;
    enableLock.current = true;
    const epoch = lifecycle.current;
    const current = () =>
      lifecycle.current === epoch &&
      enableActions[base]?.activation?.idempotencyKey === activation.idempotencyKey;
    enableActionStore.update((old) => ({ ...old, [base]: { ...old[base], pending: true } }));
    try {
      const result = await readEnableJson<{ receipt: unknown }>(
        `${base}/configuration-operations/${encodeURIComponent(activation.idempotencyKey)}`,
      );
      if (!current()) return;
      const parsed = SymposiumConfigurationOperationReceiptSchema.safeParse(result.receipt);
      if (!parsed.success) throw new Error('No exact saved activation receipt is available yet.');
      const receipt = parsed.data;
      if (
        receipt.sessionId !== activation.sessionId ||
        receipt.idempotencyKey !== activation.idempotencyKey ||
        receipt.action !== 'activate' ||
        receipt.expectedRevision !== activation.draft.revision ||
        canonicalConfigurationOperationJson(receipt.request) !==
          canonicalConfigurationOperationJson(activation.request) ||
        receipt.config.version !== 2 ||
        receipt.config.state !== 'active' ||
        receipt.config.revision !== activation.draft.revision + 1 ||
        receipt.config.anchorSeatId !== activation.draft.anchorSeatId ||
        receipt.config.seats.length !== activation.orderedSeatIds.length ||
        activation.orderedSeatIds.some((id) => !receipt.config.seats.some((seat) => seat.id === id))
      )
        throw new Error('The saved activation receipt does not match the approved setup.');
      const next = await readEnableJson<DirectorStatus>(`${base}/status`);
      if (!current()) return;
      if (
        next.sessionId !== activation.sessionId ||
        canonicalConfigurationOperationJson(next.config) !==
          canonicalConfigurationOperationJson(receipt.config)
      )
        throw new Error(
          'The agent setup changed after activation. Initial enablement remains stopped.',
        );
      resolveInitialAdmission(base, next);
      setStatus(next);
      if (
        next.seats.length !== receipt.config.seats.length ||
        receipt.config.seats.some((seat) => !next.seats.some((row) => row.seatId === seat.id)) ||
        next.seats.some(
          (seat) =>
            seat.membership &&
            (seat.membership.sessionId !== activation.sessionId ||
              seat.membership.seatId !== seat.seatId ||
              seat.membership.configRevision !== receipt.config.revision ||
              seat.membership.generation !== 1 ||
              seat.membership.idempotencyKey !== `${activation.idempotencyKey}:${seat.seatId}` ||
              seat.membership.action !== 'admit' ||
              seat.membership.reason !== 'Initial enablement by director' ||
              seat.membership.state !== 'active' ||
              seat.membership.reconciliation !== 'confirmed'),
        )
      )
        throw new Error(
          'Initial membership changed or requires recovery. No further agents will be enabled.',
        );
      enableActionStore.update((old) => ({
        ...old,
        [base]: {
          ...old[base],
          notice:
            'Saved activation confirmed. Choose Continue enabling agents to connect the remaining roster.',
          activation: {
            ...activation,
            activated: immutableEnableSnapshot(receipt.config),
            completedSeatIds: next.seats
              .filter((seat) => seat.membership)
              .map((seat) => seat.seatId),
            recovered: true,
          },
        },
      }));
      setError('');
    } catch (cause) {
      if (current()) {
        const notice = cause instanceof Error ? cause.message : 'Could not check saved activation.';
        enableActionStore.update((old) => ({
          ...old,
          [base]: { ...old[base], notice, activation: { ...activation, recovered: false } },
        }));
        setError(notice);
      }
    } finally {
      enableLock.current = false;
      enableActionStore.update((old) =>
        old[base]?.activation?.idempotencyKey === activation.idempotencyKey
          ? { ...old, [base]: { ...old[base], pending: false } }
          : old,
      );
    }
  }

  async function activateRoster(resume = false) {
    const retained = enableActions[base]?.activation;
    const config = resume ? retained?.draft : status?.config;
    if (
      !config ||
      config.version !== 2 ||
      config.state !== 'draft' ||
      enableLock.current ||
      localBusy ||
      enableActions[base]?.pending ||
      (resume
        ? !retained?.recovered ||
          !retained.activated ||
          Boolean(enableActions[base]?.uncertainAdmission)
        : !boundaryAcknowledged || busy || Boolean(enableActions[base]))
    )
      return;
    if (config.seats.length > config.activeSeatCap) {
      setError(
        'Too many agents are configured for this conversation. Reduce the roster before enabling agents. Your draft is saved.',
      );
      return;
    }
    // Set the page-lifetime fence synchronously before any network work.
    enableLock.current = true;
    const epoch = lifecycle.current;
    const current = () => lifecycle.current === epoch;
    const assertCurrent = () => {
      if (!current())
        throw new Error(
          'Agent setup was interrupted by navigation. Check the saved agent status before continuing.',
        );
    };
    const boundary = resume
      ? {
          sharedBoundaryAcknowledged: retained!.request.sharedBoundaryAcknowledged,
          ...(retained!.request.crossAccountConfirmation
            ? { crossAccountConfirmation: retained!.request.crossAccountConfirmation }
            : {}),
        }
      : {
          sharedBoundaryAcknowledged: true,
          ...(typedConfirmation === confirmation ? { crossAccountConfirmation: confirmation } : {}),
        };
    const key = resume
      ? retained!.idempotencyKey
      : (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
    const activation = resume
      ? retained!
      : {
          sessionId,
          idempotencyKey: key,
          request: immutableEnableSnapshot({
            expectedRevision: config.revision,
            idempotencyKey: key,
            ...boundary,
            ...(status?.profileBindingEnforced ? { profileSelections } : {}),
          }),
          draft: immutableEnableSnapshot(config),
          orderedSeatIds: immutableEnableSnapshot([
            config.anchorSeatId,
            ...config.seats.map((seat) => seat.id).filter((id) => id !== config.anchorSeatId),
          ]),
          completedSeatIds: [] as string[],
          activated: undefined as SymposiumConfig | undefined,
          recovered: false,
        };
    let progress = 'Saving approved agent setup';
    let activationCommitted = resume;
    enableActionStore.update((old) => ({
      ...old,
      [base]: { ...old[base], pending: true, notice: '', revision: config.revision, activation },
    }));
    setError('');
    try {
      const activated = resume
        ? activation.activated!
        : await readEnableJson<SymposiumConfig>(`${base}/activate`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify(activation.request),
          });
      activationCommitted = true;
      assertCurrent();
      if (
        activated.version !== 2 ||
        activated.state !== 'active' ||
        activated.revision !== config.revision + 1 ||
        activated.anchorSeatId !== config.anchorSeatId ||
        activated.seats.length !== config.seats.length ||
        config.seats.some((seat) => !activated.seats.some((next) => next.id === seat.id))
      )
        throw new Error('The activated agent setup changed. Refresh status before continuing.');
      enableActionStore.update((old) => ({
        ...old,
        [base]: {
          ...old[base],
          activation: {
            ...activation,
            activated: immutableEnableSnapshot(activated),
            recovered: false,
          },
        },
      }));
      setStatus((saved) =>
        saved
          ? {
              ...saved,
              config: activated,
              seats: activated.seats.map((seat) => ({
                ...(saved.seats.find((row) => row.seatId === seat.id) ?? {
                  membership: null,
                  admitted: false,
                }),
                seatId: seat.id,
                seat,
              })),
            }
          : saved,
      );
      const readExactStatus = async () => {
        const next = await readEnableJson<DirectorStatus>(`${base}/status`);
        assertCurrent();
        if (
          next.sessionId !== sessionId ||
          next.config?.state !== 'active' ||
          next.config.version !== 2 ||
          next.config.anchorSeatId !== activated.anchorSeatId ||
          next.config.revision !== activated.revision ||
          (resume &&
            canonicalConfigurationOperationJson(next.config) !==
              canonicalConfigurationOperationJson(activated)) ||
          next.seats.length !== activated.seats.length ||
          activated.seats.some((seat) => !next.seats.some((row) => row.seatId === seat.id))
        )
          throw new Error(
            'Agent setup changed during enablement. Refresh status before continuing.',
          );
        setStatus(next);
        return next;
      };
      let next = await readExactStatus();
      if (
        (!resume && next.seats.some((seat) => seat.membership)) ||
        activated.seats.length > activated.activeSeatCap
      )
        throw new Error(
          'Initial agent membership or capacity changed. Check the saved roster before continuing.',
        );
      const ordered = activation.orderedSeatIds;
      const completed = new Set(activation.completedSeatIds);
      for (const seatId of ordered) {
        assertCurrent();
        if (
          next.seats.some((seat) =>
            completed.has(seat.seatId)
              ? seat.membership?.generation !== 1 ||
                seat.membership.configRevision !== activated.revision ||
                seat.membership.state !== 'active' ||
                seat.membership.reconciliation !== 'confirmed' ||
                seat.membership.idempotencyKey !== `${key}:${seat.seatId}` ||
                seat.membership.action !== 'admit' ||
                seat.membership.sessionId !== sessionId ||
                seat.membership.reason !== 'Initial enablement by director'
              : seat.membership !== null,
          )
        )
          throw new Error(
            'Agent membership changed during enablement. Check the saved roster before continuing.',
          );
        if (completed.has(seatId)) continue;
        progress = `Connecting ${activated.seats.find((seat) => seat.id === seatId)!.name}`;
        const idempotencyKey = `${key}:${seatId}`;
        enableActionStore.update((old) => ({
          ...old,
          [base]: {
            ...old[base],
            uncertainAdmission: {
              sessionId,
              seatId,
              configRevision: activated.revision,
              expectedGeneration: 0,
              idempotencyKey,
            },
          },
        }));
        const record = await readEnableJson<SymposiumMembershipRecord>(`${base}/membership`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            seatId,
            action: 'admit',
            expectedGeneration: 0,
            configRevision: activated.revision,
            reason: 'Initial enablement by director',
            idempotencyKey,
            ...boundary,
          }),
        });
        assertCurrent();
        if (
          record.sessionId !== sessionId ||
          record.seatId !== seatId ||
          record.configRevision !== activated.revision ||
          record.idempotencyKey !== idempotencyKey ||
          record.action !== 'admit' ||
          record.reason !== 'Initial enablement by director' ||
          record.generation !== 1 ||
          record.state !== 'active'
        )
          throw new Error(
            'The agent membership receipt does not match this setup. Check status before continuing.',
          );
        if (['confirmed', 'recovery_required'].includes(record.reconciliation))
          enableActionStore.update((old) => ({
            ...old,
            [base]: { ...old[base], uncertainAdmission: undefined },
          }));
        // Retain the committed receipt even if the following status read fails.
        next = {
          ...next,
          seats: next.seats.map((seat) =>
            seat.seatId === seatId ? { ...seat, membership: record } : seat,
          ),
        };
        setStatus(next);
        if (record.reconciliation !== 'confirmed')
          throw new Error(
            'The host retained this agent membership but connection recovery is required. No further agents were enabled.',
          );
        completed.add(seatId);
        enableActionStore.update((old) => ({
          ...old,
          [base]: {
            ...old[base],
            activation: { ...old[base].activation!, completedSeatIds: [...completed] },
          },
        }));
        next = await readExactStatus();
      }
      if (
        next.seats.some(
          (seat) =>
            !completed.has(seat.seatId) ||
            seat.membership?.generation !== 1 ||
            seat.membership.configRevision !== activated.revision ||
            seat.membership.state !== 'active' ||
            seat.membership.reconciliation !== 'confirmed',
        )
      )
        throw new Error(
          'Final agent membership changed. Check the saved roster before continuing.',
        );
      assertCurrent();
      window.dispatchEvent(new Event('symposium-roster-changed'));
      enableActionStore.update((old) => {
        if (old[base]?.activation?.idempotencyKey !== key) return old;
        const next = { ...old };
        delete next[base];
        return next;
      });
    } catch (cause) {
      const notice = `Enablement stopped: ${progress}. ${cause instanceof Error ? cause.message : 'Could not enable agents'} Your saved setup and any completed membership are retained. No automatic retry will run.`;
      if (cause instanceof ActivationNotStartedError && !activationCommitted) {
        // Only this server proof permits another explicitly requested activation.
        // Missing markers, transport failures, and post-activation failures remain fenced.
        enableActionStore.update((old) => {
          if (old[base]?.activation?.idempotencyKey !== key) return old;
          const next = { ...old };
          delete next[base];
          return next;
        });
      } else {
        enableActionStore.update((old) => ({
          ...old,
          [base]: {
            ...old[base],
            pending: true,
            notice,
            revision: config.revision,
            activation: { ...old[base].activation!, recovered: false },
          },
        }));
      }
      if (current()) {
        setError(notice);
        try {
          const saved = await readEnableJson<DirectorStatus>(`${base}/status`);
          if (current() && saved.sessionId === sessionId) {
            resolveInitialAdmission(base, saved);
            setStatus(saved);
          }
        } catch {
          /* Keep the last saved config and membership receipts. */
        }
      }
    } finally {
      enableLock.current = false;
      enableActionStore.update((old) =>
        old[base]?.activation?.idempotencyKey === key
          ? { ...old, [base]: { ...old[base], pending: false } }
          : old,
      );
    }
  }

  async function addConfiguredSeat() {
    const config = status?.config;
    if (
      !config ||
      config.version !== 2 ||
      !newSeatId.trim() ||
      !newSeatName.trim() ||
      !newSeatSelection?.accountId ||
      busy
    )
      return;
    setBusy(true);
    setError('');
    try {
      if (config.state === 'active') {
        await readJson(`${base}/seats/revise`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            expectedRevision: config.revision,
            seatId: newSeatId.trim(),
            name: newSeatName.trim(),
            role: newSeatRole,
            systemPrompt: '',
            color: '#665599',
            accountId: newSeatSelection.accountId,
            model: newSeatSelection.model,
            ...(newSeatSelection.reasoningEffort
              ? { reasoningEffort: newSeatSelection.reasoningEffort }
              : {}),
            ...(status.profileBindingEnforced && newSeatProfile
              ? { profileSelection: newSeatProfile }
              : {}),
            sharedBoundaryAcknowledged: boundaryAcknowledged,
            ...(typedConfirmation === confirmation
              ? { crossAccountConfirmation: confirmation }
              : {}),
          }),
        });
        setNewSeatId('');
        setNewSeatName('');
        setNewSeatProfile(null);
        await refresh();
        return;
      }
      const { binding } = await readJson<{ binding: ValidAccountBinding }>(`${base}/selection`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          accountId: newSeatSelection.accountId,
          model: newSeatSelection.model,
          ...(newSeatSelection.reasoningEffort
            ? { reasoningEffort: newSeatSelection.reasoningEffort }
            : {}),
        }),
      });
      const next = {
        ...config,
        revision: config.revision + 1,
        seats: [
          ...config.seats,
          {
            id: newSeatId.trim(),
            name: newSeatName.trim(),
            role: newSeatRole,
            model: newSeatSelection.model,
            systemPrompt: '',
            color: '#665599',
            accountBinding: binding,
            ...(newSeatSelection.reasoningEffort
              ? { reasoningEffort: newSeatSelection.reasoningEffort }
              : {}),
          },
        ],
      };
      await readJson(`${base}/config`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ expectedRevision: config.revision, config: next }),
      });
      setNewSeatId('');
      setNewSeatName('');
      // Draft profiles are selected at activation, outside the client seat config.
      if (status.profileBindingEnforced && newSeatProfile)
        setProfileSelections((current) => ({ ...current, [newSeatId.trim()]: newSeatProfile }));
      setNewSeatProfile(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add seat');
    } finally {
      setBusy(false);
    }
  }

  async function applyProfile(seat: DirectorSeat) {
    const config = status?.config;
    const selection = profileSelections[seat.seatId];
    const binding = seat.seat.accountBinding;
    if (
      !config ||
      config.state !== 'active' ||
      !status?.profileBindingEnforced ||
      !selection ||
      !binding ||
      seat.membership?.state === 'active' ||
      busy ||
      !boundaryAcknowledged
    )
      return;
    setBusy(true);
    setError('');
    try {
      await readJson(`${base}/seats/revise`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          expectedRevision: config.revision,
          seatId: seat.seatId,
          name: seat.seat.name,
          role: seat.seat.role,
          systemPrompt: seat.seat.systemPrompt,
          ...(seat.seat.authorityRequest ? { authorityRequest: seat.seat.authorityRequest } : {}),
          ...(seat.seat.expectedOutput !== undefined
            ? { expectedOutput: seat.seat.expectedOutput }
            : {}),
          ...(seat.seat.acceptanceCriteria !== undefined
            ? { acceptanceCriteria: seat.seat.acceptanceCriteria }
            : {}),
          color: seat.seat.color,
          accountId: binding.accountId,
          model: seat.seat.model,
          ...(seat.seat.reasoningEffort ? { reasoningEffort: seat.seat.reasoningEffort } : {}),
          profileSelection: selection,
          sharedBoundaryAcknowledged: true,
          ...(typedConfirmation === confirmation ? { crossAccountConfirmation: confirmation } : {}),
        }),
      });
      setProfileSelections((current) => {
        const next = { ...current };
        delete next[seat.seatId];
        return next;
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not apply profile');
    } finally {
      setBusy(false);
    }
  }

  function transition(seat: DirectorSeat, action: 'admit' | 'suspend' | 'remove' | 'restore') {
    const config = status?.config;
    if (!config) return;
    void mutate('/membership', {
      seatId: seat.seatId,
      action,
      expectedGeneration: seat.membership?.generation ?? 0,
      configRevision: config.revision,
      reason: `${action} by director`,
      ...(['admit', 'restore'].includes(action) && boundaryAcknowledged
        ? { sharedBoundaryAcknowledged: true }
        : {}),
      ...(typedConfirmation === confirmation ? { crossAccountConfirmation: confirmation } : {}),
    });
  }

  const accessConsent = status?.config ? (
    <div className="symposium-access-consent">
      <label>
        <input
          type="checkbox"
          checked={boundaryAcknowledged}
          onChange={(event) => setBoundaryAcknowledged(event.target.checked)}
        />
        <span>
          I understand these agents can access shared files within their permissions, and their
          provider accounts may retain messages.
        </span>
      </label>
      {(crossesAnchorAccount(status.config) ||
        (newSeatSelection?.accountId &&
          newSeatSelection.accountId !== anchorAccountId(status.config))) && (
        <label>
          To use another account, type {confirmation}:{' '}
          <input
            value={typedConfirmation}
            onChange={(event) => setTypedConfirmation(event.target.value)}
          />
        </label>
      )}
    </div>
  ) : null;

  const admitted = status?.seats.filter(canRequestAgent) ?? [];
  return (
    <section className="symposium-director" aria-label="Symposium director">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Agents
      </button>
      {open && (
        <div className="symposium-director-panel">
          <p className="symposium-team-intro">
            You direct the team: choose which agents participate and what each receives.
          </p>
          <button
            type="button"
            disabled={loading || localBusy || enableAction?.pending === true}
            onClick={() => void refresh()}
          >
            Refresh status
          </button>
          {loading && <p role="status">Checking agent status…</p>}
          {(localBusy || enableAction?.pending === true) && (
            <p role="status">
              Working on your request… Connecting an agent can take several minutes while its
              account and workspace access are checked.
            </p>
          )}
          {enableAction?.notice && <p role="status">{enableAction.notice}</p>}
          {enableAction?.activation && !enableAction.pending && (
            <div>
              <button
                type="button"
                disabled={localBusy}
                onClick={() => void checkSavedActivation()}
              >
                Check saved activation
              </button>
              {enableAction.activation.recovered && (
                <button
                  type="button"
                  disabled={localBusy || Boolean(enableAction.uncertainAdmission)}
                  onClick={() => void activateRoster(true)}
                >
                  Continue enabling agents
                </button>
              )}
            </div>
          )}
          {error && (
            <div role="alert">
              <p>The request couldn’t be completed.</p>
              <AdvancedControls label="View request error">
                <p>{error}</p>
                <button type="button" onClick={() => void refresh()}>
                  Refresh status
                </button>
              </AdvancedControls>
            </div>
          )}
          {status && !status.config && (
            <div>
              <p>This conversation has no agents configured.</p>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => void createDraft()}
              >
                Set up agents
              </button>
              <AdvancedControls label="Advanced and troubleshooting" revealKey={reviewHandoff}>
                <SymposiumSourceImportPanel key={sessionId} sessionId={sessionId} />
              </AdvancedControls>
            </div>
          )}
          {status?.config && (
            <>
              {status.config.state === 'draft' && (
                <section className="symposium-setup" aria-label="Finish agent setup">
                  <div className="symposium-setup-heading">
                    <h3>Finish agent setup</h3>
                    <p>Your setup is saved. Agents cannot run until you enable them.</p>
                  </div>
                  <ol className="symposium-setup-steps">
                    <li>
                      <h4>1. Prepare the workspace</h4>
                      <p>Prepare shared files for this conversation.</p>
                      <button
                        type="button"
                        disabled={busy || loading}
                        onClick={() => void prepareArtifacts()}
                      >
                        Prepare shared workspace
                      </button>
                      {artifactMessage && <p role="status">{artifactMessage}</p>}
                    </li>
                    <li>
                      <h4>2. Review access</h4>
                      <p>Choosing message context does not restrict file access.</p>
                      {accessConsent}
                    </li>
                    <li>
                      <h4>3. Enable agents</h4>
                      <p>
                        The host checks each agent’s account and workspace access before it can
                        receive messages.
                      </p>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={
                          busy ||
                          Boolean(enableAction) ||
                          !boundaryAcknowledged ||
                          (crossesAnchorAccount(status.config) &&
                            typedConfirmation !== confirmation)
                        }
                        onClick={() => void activateRoster()}
                      >
                        Enable agents
                      </button>
                    </li>
                  </ol>
                </section>
              )}
              <h3>Team members</h3>
              <p>
                The primary agent handles the conversation. Reviewers provide read-only feedback.
                Suspend pauses an agent; Remove takes it off the team.
              </p>
              <ul className="symposium-roster">
                {status.seats.map((seat) => (
                  <li key={seat.seatId} aria-label={`${seat.seat.name} agent`}>
                    <div className="symposium-agent-heading">
                      <strong>
                        <SeatLabel seatId={seat.seatId} name={seat.seat.name} />
                      </strong>
                      <span className="symposium-agent-state">
                        {seat.creationDiagnostic
                          ? 'Couldn’t connect this agent'
                          : canRequestAgent(seat)
                            ? status.statusMode === 'durable' ||
                              seat.admissionRecorded !== undefined
                              ? 'Added'
                              : 'Connected'
                            : seat.membership?.state === 'suspended'
                              ? 'Paused'
                              : seat.membership?.state === 'removed'
                                ? 'Removed'
                                : status.config!.state === 'draft'
                                  ? 'Not enabled'
                                  : 'Not connected'}
                      </span>
                    </div>
                    <div className="symposium-agent-model">
                      <span>
                        Account: {seat.seat.accountBinding?.accountLabel ?? 'Not selected'}
                      </span>
                      <span>
                        Model: {seat.seat.model}
                        {seat.seat.reasoningEffort ? ` · ${seat.seat.reasoningEffort}` : ''}
                      </span>
                    </div>
                    {seat.creationDiagnostic && <p>Workspace setup failed. No message was sent.</p>}
                    {canRequestAgent(seat) &&
                      seat.seatId !==
                        (status.config!.version === 2
                          ? status.config!.anchorSeatId
                          : status.config!.seats[0]?.id) && (
                        <div className="symposium-agent-actions">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => transition(seat, 'suspend')}
                          >
                            Pause agent
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => transition(seat, 'remove')}
                          >
                            Remove agent
                          </button>
                        </div>
                      )}
                    <AdvancedControls label="View details" onOpen={() => void checkDetails(seat)}>
                      <div className="symposium-agent-details">
                        {detailChecks[seat.seatId]?.pending && (
                          <p role="status">Checking connection details…</p>
                        )}
                        {detailChecks[seat.seatId]?.error && (
                          <div role="alert">
                            <p>Couldn’t check connection details.</p>
                            <details>
                              <summary>Technical details</summary>
                              {detailChecks[seat.seatId].error}
                            </details>
                            <button type="button" onClick={() => void checkDetails(seat)}>
                              Try checking again
                            </button>
                          </div>
                        )}
                        <strong>{seat.seat.name}</strong> · {seat.seat.role} ·{' '}
                        {seat.seat.accountBinding?.accountLabel ?? 'Account unknown'} ·{' '}
                        {seat.seat.model}
                        {seat.seat.reasoningEffort ? ` · ${seat.seat.reasoningEffort}` : ''}
                        <span>
                          {' '}
                          ·{' '}
                          {seat.admitted
                            ? 'Admitted'
                            : seat.membership?.reconciliation === 'recovery_required'
                              ? 'Cleanup required'
                              : 'Pending runtime admission'}
                        </span>
                        {seat.creationDiagnostic && !detailChecks[seat.seatId]?.pending && (
                          <div role="status">
                            Creation failed during {seat.creationDiagnostic.phase}:{' '}
                            {seat.creationDiagnostic.code}.
                            {seat.creationDiagnostic.canCleanup &&
                            !detailChecks[seat.seatId]?.error ? (
                              <>
                                <p>
                                  Clean up this failed sandbox. The seat will be suspended; Restore
                                  requires a separate action.
                                </p>
                                <label>
                                  Type CLEAN UP FAILED SEAT for {seat.seat.name}
                                  <input
                                    value={cleanupConfirmation[seat.seatId] ?? ''}
                                    onChange={(event) =>
                                      setCleanupConfirmation({
                                        ...cleanupConfirmation,
                                        [seat.seatId]: event.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <button
                                  type="button"
                                  disabled={
                                    busy ||
                                    cleanupConfirmation[seat.seatId] !== 'CLEAN UP FAILED SEAT'
                                  }
                                  onClick={() =>
                                    void mutate('/creation/recover', {
                                      seatId: seat.seatId,
                                      expectedRevision: status.config!.revision,
                                      expectedGeneration: seat.membership!.generation,
                                      confirmation: cleanupConfirmation[seat.seatId],
                                      ...(seat.creationDiagnostic?.recoveryIdempotencyKey
                                        ? {
                                            idempotencyKey:
                                              seat.creationDiagnostic.recoveryIdempotencyKey,
                                          }
                                        : {}),
                                    })
                                  }
                                >
                                  Clean up failed seat
                                </button>
                              </>
                            ) : seat.creationDiagnostic.recoveryAuthorization?.state ===
                                'reauthorization_required' && !detailChecks[seat.seatId]?.error ? (
                              <CreationRecoveryAuthorization
                                key={`${sessionId}:${seat.seatId}:${seat.membership!.generation}:${status.config!.revision}:${seat.creationDiagnostic.recoveryAuthorization.operationId}:${seat.creationDiagnostic.recoveryAuthorization.revision}`}
                                sessionId={sessionId}
                                seat={seat}
                                revision={status.config!.revision}
                                onSaved={async () => {
                                  setCleanupConfirmation((current) => ({
                                    ...current,
                                    [seat.seatId]: '',
                                  }));
                                  await refresh();
                                }}
                              />
                            ) : seat.creationDiagnostic.recoveryAuthorization?.state ===
                              'cleanup_fenced' ? (
                              <p>
                                Cleanup is fenced: physical work may still be running or its outcome
                                is uncertain. Automatic retry and authorization transfer are
                                unavailable.
                              </p>
                            ) : (
                              <p>
                                Exact retained creation proof is unavailable. Host recovery is
                                required.
                              </p>
                            )}
                          </div>
                        )}
                        {status.config?.version === 2 &&
                        seat.seatId === status.config.anchorSeatId &&
                        seat.membership?.state === 'active' ? (
                          <span>
                            {seat.creationDiagnostic
                              ? 'Failed seat cleanup preserves the primary role and account binding.'
                              : 'Transfer primary ownership before suspending, removing, or rebinding this seat.'}
                          </span>
                        ) : seat.membership?.state === 'active' ? (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => transition(seat, 'suspend')}
                            >
                              Suspend
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => transition(seat, 'remove')}
                            >
                              Remove
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={busy || !canRequestRuntime(status) || !boundaryAcknowledged}
                            onClick={() =>
                              transition(
                                seat,
                                seat.membership?.state === 'suspended' ? 'restore' : 'admit',
                              )
                            }
                          >
                            {localBusy || enableAction?.pending === true
                              ? 'Working…'
                              : seat.membership?.state === 'suspended'
                                ? 'Resume agent'
                                : 'Enable agent'}
                          </button>
                        )}
                        {seat.membership?.state !== 'active' &&
                          !enableAction?.uncertainAdmission && (
                            <SeatModelEditor
                              sessionId={sessionId}
                              seat={seat}
                              config={status.config!}
                              profileSelection={
                                profileSelections[seat.seatId] ??
                                (seat.seat.profileBinding &&
                                !seat.seat.profileBinding.profileId.startsWith('host-profile:')
                                  ? {
                                      profileId: seat.seat.profileBinding.profileId,
                                      revision: Number(seat.seat.profileBinding.profileRevision),
                                    }
                                  : null)
                              }
                              onSaved={refresh}
                            />
                          )}
                        {status.profileBindingEnforced && (
                          <div>
                            {seat.seat.profileBinding && (
                              <p>
                                Bound profile: {seat.seat.profileBinding.profileId} · v
                                {seat.seat.profileBinding.profileRevision}
                              </p>
                            )}
                            <SymposiumProfilePicker
                              compact
                              value={profileSelections[seat.seatId] ?? null}
                              onChange={(selection) =>
                                setProfileSelections((current) => {
                                  const next = { ...current };
                                  if (selection) next[seat.seatId] = selection;
                                  else delete next[seat.seatId];
                                  return next;
                                })
                              }
                              disabled={
                                busy ||
                                (status.config!.state === 'active' &&
                                  seat.membership?.state === 'active')
                              }
                            />
                            {status.config!.state === 'active' &&
                              profileSelections[seat.seatId] && (
                                <button
                                  type="button"
                                  disabled={
                                    busy ||
                                    !boundaryAcknowledged ||
                                    seat.membership?.state === 'active'
                                  }
                                  onClick={() => void applyProfile(seat)}
                                >
                                  Apply selected profile
                                </button>
                              )}
                          </div>
                        )}
                      </div>
                    </AdvancedControls>
                  </li>
                ))}
              </ul>
              <AdvancedControls label="Advanced and troubleshooting" revealKey={reviewHandoff}>
                <SymposiumSourceImportPanel key={sessionId} sessionId={sessionId} />
                {status.config.state === 'active' && (
                  <p>
                    Agents can access shared workspace files within their permissions. Choosing
                    message context does not restrict file access.
                  </p>
                )}
                {status.config.state === 'active' && (
                  <p>
                    {status.reservedSeats} of{' '}
                    {status.config.version === 2 ? status.config.activeSeatCap : 2} seats reserved.
                  </p>
                )}
                {!canRequestRuntime(status) && (
                  <p role="status">
                    The agent service is unavailable. Agents cannot connect or receive messages yet.
                    You can still revoke access or stop deliveries.
                  </p>
                )}
                {status.config.state === 'active' &&
                  status.seats.some(
                    (seat) =>
                      seat.membership?.state === 'active' &&
                      seat.membership.reconciliation === 'confirmed' &&
                      !seat.admitted &&
                      (!seat.admission ||
                        seat.admission.configRevision !== status.config?.revision ||
                        seat.admission.membershipGeneration !== seat.membership.generation),
                  ) && (
                    <button
                      type="button"
                      disabled={busy || !canRequestRuntime(status)}
                      onClick={() => void refreshAdmissions()}
                    >
                      Recheck retained seat admissions
                    </button>
                  )}
                {status.config.state === 'active' && accessConsent}
                {status.config.version === 2 && status.config.state === 'active' && (
                  <AdvancedControls label="Change conversation owner">
                    <fieldset disabled={busy || !canRequestRuntime(status)}>
                      <legend>Transfer primary seat</legend>
                      <p>
                        Select an admitted seat to own conversation routing. Its permissions stay
                        unchanged. Transfer first, then remove the old writer and wait for cleanup
                        before adding a replacement writer.
                      </p>
                      <label>
                        New primary seat
                        <select
                          value={primarySelection}
                          onChange={(event) => setPrimarySelection(event.target.value)}
                        >
                          <option value="">Select a seat</option>
                          {status.seats
                            .filter(
                              (seat) =>
                                seat.seatId !==
                                  (status.config?.version === 2
                                    ? status.config.anchorSeatId
                                    : '') &&
                                canRequestAgent(seat) &&
                                seat.membership?.state === 'active' &&
                                seat.membership.reconciliation === 'confirmed',
                            )
                            .map((seat) => (
                              <option key={seat.seatId} value={seat.seatId}>
                                {seat.seat.name} ({seat.seat.accountBinding?.accountLabel};{' '}
                                {seat.seat.model})
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Type TRANSFER PRIMARY SEAT to confirm
                        <input
                          value={primaryConfirmation}
                          onChange={(event) => setPrimaryConfirmation(event.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={
                          !primarySelection || primaryConfirmation !== 'TRANSFER PRIMARY SEAT'
                        }
                        onClick={() => {
                          const target = status.seats.find(
                            (seat) => seat.seatId === primarySelection,
                          );
                          if (
                            status.config?.version !== 2 ||
                            !target ||
                            !canRequestAgent(target) ||
                            target.membership?.state !== 'active' ||
                            target.membership.reconciliation !== 'confirmed'
                          )
                            return;
                          void mutate('/primary/transfer', {
                            fromSeatId: status.config.anchorSeatId,
                            toSeatId: target.seatId,
                            expectedRevision: status.config.revision,
                            expectedGeneration: target.membership.generation,
                            reason: 'Explicit primary transfer by director',
                            confirmation: primaryConfirmation,
                          });
                        }}
                      >
                        Transfer primary seat
                      </button>
                    </fieldset>
                  </AdvancedControls>
                )}
                {status.config.version === 2 && (
                  <AdvancedControls label="Configure agents manually">
                    <div className="symposium-new-seat">
                      <h3>Configure an agent manually</h3>
                      <label>
                        New seat name{' '}
                        <input
                          aria-label="New seat name"
                          value={newSeatName}
                          onChange={(event) => setNewSeatName(event.target.value)}
                        />
                      </label>
                      <label>
                        New seat ID{' '}
                        <input
                          aria-label="New seat ID"
                          value={newSeatId}
                          onChange={(event) => setNewSeatId(event.target.value)}
                        />
                      </label>
                      <label>
                        Role{' '}
                        <select
                          value={newSeatRole}
                          onChange={(event) => setNewSeatRole(event.target.value)}
                        >
                          <option value="architect">Architect</option>
                          <option value="reviewer">Reviewer</option>
                          <option value="implementer">Implementer</option>
                        </select>
                      </label>
                      <AccountModelPicker
                        scope="symposium"
                        sessionId={null}
                        preferredModel={status.config.seats[0]?.model ?? ''}
                        onChange={setNewSeatSelection}
                        disabled={busy}
                      />
                      {status.profileBindingEnforced && (
                        <SymposiumProfilePicker
                          compact
                          value={newSeatProfile}
                          onChange={setNewSeatProfile}
                          disabled={busy}
                        />
                      )}
                      <button
                        type="button"
                        disabled={
                          busy ||
                          !newSeatName.trim() ||
                          !newSeatId.trim() ||
                          !newSeatSelection?.accountId ||
                          (status.config.state === 'active' &&
                            (!boundaryAcknowledged ||
                              (newSeatSelection.accountId !== anchorAccountId(status.config) &&
                                typedConfirmation !== confirmation)))
                        }
                        onClick={() => void addConfiguredSeat()}
                      >
                        Save agent configuration
                      </button>
                      <p>
                        Saving adds this agent to the configuration. It can receive messages only
                        after the host verifies its access and enables it.
                      </p>
                    </div>
                  </AdvancedControls>
                )}
                <fieldset disabled={busy || !canRequestRuntime(status) || admitted.length === 0}>
                  <legend>Direct a message</legend>
                  {admitted.map((seat) => (
                    <label key={seat.seatId}>
                      <input
                        type="checkbox"
                        aria-label={`Send to ${seat.seat.name}`}
                        checked={selected.includes(seat.seatId)}
                        onChange={() =>
                          setSelected((current) =>
                            current.includes(seat.seatId)
                              ? current.filter((id) => id !== seat.seatId)
                              : [...current, seat.seatId],
                          )
                        }
                      />
                      <span>{seat.seat.name}</span>
                    </label>
                  ))}
                  <label>
                    Message for the selected agents{' '}
                    <textarea
                      aria-label="Message for the selected agents"
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={
                      busy || !canRequestRuntime(status) || selected.length === 0 || !message.trim()
                    }
                    onClick={() =>
                      void mutate('/deliveries', {
                        sourceSeatId: null,
                        recipientSeatIds: selected,
                        originalContent: message.trim(),
                      })
                    }
                  >
                    Queue message for selected agents
                  </button>
                </fieldset>
                <h3>Review requests</h3>
                {status.deliveries.length === 0 && (
                  <p>No review requests yet. Add an agent or queue a message.</p>
                )}
                <ul>
                  {status.deliveries.map((delivery) => (
                    <li key={delivery.deliveryId}>
                      <strong>{delivery.recipientSeatIds.join(', ')}</strong> · {delivery.status}
                      <p>{delivery.deliveredContent ?? delivery.originalContent}</p>
                      {delivery.status === 'awaiting_intervention' && (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                `/deliveries/${encodeURIComponent(delivery.deliveryId)}/interventions`,
                                { action: 'approve' },
                              )
                            }
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                `/deliveries/${encodeURIComponent(delivery.deliveryId)}/interventions`,
                                { action: 'drop', reason: 'Dropped by director' },
                              )
                            }
                          >
                            Drop
                          </button>
                          <label>
                            Edit delivery{' '}
                            <textarea
                              value={editContent}
                              onChange={(event) => setEditContent(event.target.value)}
                            />
                          </label>
                          <button
                            type="button"
                            disabled={busy || !editContent.trim()}
                            onClick={() =>
                              void mutate(
                                `/deliveries/${encodeURIComponent(delivery.deliveryId)}/interventions`,
                                { action: 'edit', content: editContent.trim() },
                              )
                            }
                          >
                            Edit and approve
                          </button>
                        </>
                      )}
                      {delivery.status === 'ready' && (
                        <button
                          type="button"
                          disabled={busy || !canRequestRuntime(status)}
                          onClick={() =>
                            void mutate(
                              `/deliveries/${encodeURIComponent(delivery.deliveryId)}/dispatch`,
                              {},
                            )
                          }
                        >
                          Send approved message
                        </button>
                      )}
                      {!['delivered', 'dropped', 'cancelled'].includes(delivery.status) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              `/deliveries/${encodeURIComponent(delivery.deliveryId)}/cancel`,
                              { reason: 'Stopped by director' },
                            )
                          }
                        >
                          Stop and dismiss
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </AdvancedControls>
            </>
          )}
          <details className="symposium-advanced">
            <summary>Advanced: import context from another conversation</summary>
            <SymposiumSourceImportPanel key={sessionId} sessionId={sessionId} />
          </details>
        </div>
      )}
    </section>
  );
}
