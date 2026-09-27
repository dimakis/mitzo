import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SeatConfig,
  SymposiumConfig,
  SymposiumDeliveryRecord,
  SymposiumMembershipRecord,
  ValidAccountBinding,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { AccountModelPicker, type AccountSelection } from './AccountModelPicker';
import { SymposiumProfilePicker, type SymposiumProfileSelection } from './SymposiumProfilePicker';

interface DirectorSeat {
  seatId: string;
  seat: SeatConfig;
  membership: SymposiumMembershipRecord | null;
  admitted: boolean;
}
interface DirectorStatus {
  sessionId: string;
  config: SymposiumConfig | null;
  seats: DirectorSeat[];
  runtimeAvailable: boolean;
  profileBindingEnforced?: boolean;
  initialProfileSelections?: Record<string, SymposiumProfileSelection>;
  reservedSeats: number;
  capacityRemaining: number;
  deliveries: SymposiumDeliveryRecord[];
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

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
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
              ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
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
          I understand the shared artifacts and provider account retention boundary.
        </label>
      )}
      <label>
        Cross-account confirmation{' '}
        <input
          value={typedConfirmation}
          onChange={(event) => setTypedConfirmation(event.target.value)}
          placeholder={confirmation}
        />
      </label>
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
        Save seat model
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
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [editContent, setEditContent] = useState('');
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

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setLoading(true);
    try {
      const next = await readJson<DirectorStatus>(base);
      if (generation !== refreshGeneration.current) return;
      setStatus(next);
      setProfileSelections((current) => ({ ...next.initialProfileSelections, ...current }));
      setSelected((current) =>
        current.filter((id) => next.seats.some((seat) => seat.seatId === id && seat.admitted)),
      );
      setError('');
    } catch (cause) {
      if (generation === refreshGeneration.current)
        setError(cause instanceof Error ? cause.message : 'Director status unavailable');
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    setStatus(null);
    setSelected([]);
    setProfileSelections({});
    pendingKeys.current.clear();
    if (open) void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [sessionId, open, refresh]);

  async function mutate(path: string, payload: Record<string, unknown>, method = 'POST') {
    if (busy) return;
    setBusy(true);
    setError('');
    const fingerprint = JSON.stringify([path, payload]);
    let idempotencyKey = pendingKeys.current.get(fingerprint);
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
      window.dispatchEvent(new Event('symposium-roster-changed'));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Director action failed');
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

  async function activateRoster() {
    const config = status?.config;
    if (!config || config.state !== 'draft' || !boundaryAcknowledged || busy) return;
    setBusy(true);
    setError('');
    try {
      await readJson(`${base}/activate`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          expectedRevision: config.revision,
          sharedBoundaryAcknowledged: true,
          ...(typedConfirmation === confirmation ? { crossAccountConfirmation: confirmation } : {}),
          ...(status?.profileBindingEnforced ? { profileSelections } : {}),
        }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not activate roster');
    } finally {
      setBusy(false);
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

  const admitted = status?.seats.filter((seat) => seat.admitted) ?? [];
  return (
    <section className="symposium-director" aria-label="Symposium director">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Director controls
      </button>
      {open && (
        <div className="symposium-director-panel">
          <button type="button" disabled={loading || busy} onClick={() => void refresh()}>
            Refresh director status
          </button>
          {loading && <p role="status">Loading Symposium…</p>}
          {error && (
            <p role="alert">
              {error}{' '}
              <button type="button" onClick={() => void refresh()}>
                Retry
              </button>
            </p>
          )}
          {status && !status.config && (
            <div>
              <p>This conversation has no Symposium roster.</p>
              <button type="button" disabled={busy} onClick={() => void createDraft()}>
                Create draft Symposium
              </button>
            </div>
          )}
          {status?.config && (
            <>
              <p>
                Shared artifacts and provider account retention apply to every admitted seat.
                Selected prompt delivery is separate from filesystem access.
              </p>
              <p>
                {status.config.state === 'draft'
                  ? 'Draft — provider seats are not admitted.'
                  : `${status.reservedSeats} of ${status.config.version === 2 ? status.config.activeSeatCap : 2} seats reserved.`}
              </p>
              {!status.runtimeAvailable && (
                <p role="status">
                  Provider runtime unavailable. Admission and dispatch remain pending; revocation
                  and cancellation stay available.
                </p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={boundaryAcknowledged}
                  onChange={(event) => setBoundaryAcknowledged(event.target.checked)}
                />
                I acknowledge the shared artifacts and provider account retention boundary.
              </label>
              <label>
                To add a seat on another account, type {confirmation}:{' '}
                <input
                  value={typedConfirmation}
                  onChange={(event) => setTypedConfirmation(event.target.value)}
                />
              </label>
              {status.config.state === 'draft' && (
                <button
                  type="button"
                  disabled={
                    busy ||
                    !boundaryAcknowledged ||
                    (crossesAnchorAccount(status.config) && typedConfirmation !== confirmation)
                  }
                  onClick={() => void activateRoster()}
                >
                  Activate roster
                </button>
              )}
              <ul className="symposium-roster">
                {status.seats.map((seat) => (
                  <li key={seat.seatId}>
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
                    {seat.membership?.state === 'active' ? (
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
                        disabled={busy || !status.runtimeAvailable || !boundaryAcknowledged}
                        onClick={() =>
                          transition(
                            seat,
                            seat.membership?.state === 'suspended' ? 'restore' : 'admit',
                          )
                        }
                      >
                        {seat.membership?.state === 'suspended' ? 'Restore' : 'Add seat'}
                      </button>
                    )}
                    {seat.membership?.state !== 'active' && (
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
                        {status.config!.state === 'active' && profileSelections[seat.seatId] && (
                          <button
                            type="button"
                            disabled={
                              busy || !boundaryAcknowledged || seat.membership?.state === 'active'
                            }
                            onClick={() => void applyProfile(seat)}
                          >
                            Apply selected profile
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {status.config.version === 2 && (
                <div className="symposium-new-seat">
                  <h3>Configure another seat</h3>
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
                    Add configured seat
                  </button>
                  <p>
                    Configured seats remain pending until runtime grants and provider admission are
                    verified.
                  </p>
                </div>
              )}
              <fieldset disabled={busy || !status.runtimeAvailable || admitted.length === 0}>
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
                    {seat.seat.name}
                  </label>
                ))}
                <label>
                  Director message{' '}
                  <textarea
                    aria-label="Director message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={
                    busy || !status.runtimeAvailable || selected.length === 0 || !message.trim()
                  }
                  onClick={() =>
                    void mutate('/deliveries', {
                      sourceSeatId: null,
                      recipientSeatIds: selected,
                      originalContent: message.trim(),
                    })
                  }
                >
                  Inject to selected seats
                </button>
              </fieldset>
              <h3>Directed deliveries</h3>
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
                        disabled={busy || !status.runtimeAvailable}
                        onClick={() =>
                          void mutate(
                            `/deliveries/${encodeURIComponent(delivery.deliveryId)}/dispatch`,
                            {},
                          )
                        }
                      >
                        Step delivery
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
            </>
          )}
        </div>
      )}
    </section>
  );
}
