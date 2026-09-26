import { useEffect, useRef, useState } from 'react';
import type { SymposiumConfig, ValidAccountBinding } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { AccountModelPicker, type AccountSelection } from './AccountModelPicker';
import { SymposiumProfilePicker, type SymposiumProfileSelection } from './SymposiumProfilePicker';
import './AddReviewerSheet.css';

type Status = {
  config: SymposiumConfig | null;
  runtimeAvailable: boolean;
  initialProfileSelections?: Record<string, SymposiumProfileSelection>;
  seats: { seatId: string; membership: { state: string; generation: number } | null }[];
};
type Mode = 'independent' | 'summary' | 'selected-turns' | 'full-context';
const confirmation = 'ADD CROSS-ACCOUNT SEAT';
async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await apiFetch(
    path,
    body === undefined
      ? undefined
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Reviewer request failed');
  return result as T;
}

export function AddReviewerSheet({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setVisited(true);
          setOpen(true);
        }}
      >
        Add reviewer
      </button>
      {visited && (
        <ReviewerForm
          key={`${sessionId}:${attempt}`}
          open={open}
          sessionId={sessionId}
          onClose={() => setOpen(false)}
          onAnother={() => setAttempt((value) => value + 1)}
        />
      )}
    </>
  );
}
function ReviewerForm({
  sessionId,
  onClose,
  open,
  onAnother,
}: {
  sessionId: string;
  onClose(): void;
  open: boolean;
  onAnother(): void;
}) {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/symposium`;
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
  const [selection, setSelection] = useState<AccountSelection | null>(null);
  const [profile, setProfile] = useState<SymposiumProfileSelection | null>(null);
  const [mode, setMode] = useState<Mode>('independent');
  const [brief, setBrief] = useState('');
  const [summary, setSummary] = useState('');
  const [turns, setTurns] = useState<{ id: string; content: string }[]>([]);
  const [turnIds, setTurnIds] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [locked, setLocked] = useState(false);
  const [progress, setProgress] = useState('');
  const packageSnapshot = useRef<{ content: string } | null>(null);
  const operation = useRef({ seatId: `reviewer-${crypto.randomUUID()}`, key: crypto.randomUUID() });
  useEffect(() => {
    let live = true;
    request<Status>(base)
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [base]);
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
  const crossAccount = Boolean(
    anchor?.accountBinding && selection?.accountId !== anchor.accountBinding.accountId,
  );
  const ready = Boolean(
    status &&
    (!status.config || status.runtimeAvailable) &&
    profile &&
    selection?.accountId &&
    brief.trim() &&
    acknowledged &&
    (!crossAccount || typed === confirmation) &&
    (mode !== 'summary' || summary.trim()) &&
    (mode !== 'selected-turns' || turnIds.length),
  );
  async function add() {
    if (!ready || !selection || !profile || busy) return;
    setBusy(true);
    setError('');
    try {
      const context =
        packageSnapshot.current ??
        (await request<{ content: string }>(`${base}/context-package`, {
          mode,
          ...(mode === 'summary' ? { summary } : {}),
          ...(mode === 'selected-turns' ? { turnIds } : {}),
        }));
      let current = await request<Status>(base);
      let config = current.config;
      if (!config) config = await request<SymposiumConfig>(`${base}/draft`, {});
      if (config.version !== 2)
        throw new Error('This roster must be upgraded before adding a reviewer');
      const configuredAnchorId = config.anchorSeatId;
      const configuredAnchor = config.seats.find((seat) => seat.id === configuredAnchorId);
      if (
        configuredAnchor?.accountBinding &&
        configuredAnchor.accountBinding.accountId !== selection.accountId &&
        typed !== confirmation
      )
        throw new Error('Confirm the cross-account transfer before binding the reviewer');
      packageSnapshot.current = context;
      setLocked(true);
      const boundary = {
        sharedBoundaryAcknowledged: true,
        ...(typed === confirmation ? { crossAccountConfirmation: confirmation } : {}),
      };
      const seatId = operation.current.seatId;
      if (!config.seats.some((seat) => seat.id === seatId)) {
        if (config.state === 'active') {
          config = await request<SymposiumConfig>(`${base}/seats/revise`, {
            expectedRevision: config.revision,
            seatId,
            name: 'Reviewer',
            role: 'reviewer',
            systemPrompt: '',
            color: '#665599',
            accountId: selection.accountId,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
            profileSelection: profile,
            contextSourceRefs: [],
            ...boundary,
          });
        } else {
          const { binding } = await request<{ binding: ValidAccountBinding }>(`${base}/selection`, {
            accountId: selection.accountId,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          });
          config = await request<SymposiumConfig>(
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
                    name: 'Reviewer',
                    role: 'reviewer',
                    systemPrompt: '',
                    color: '#665599',
                    model: selection.model,
                    accountBinding: binding,
                    ...(selection.reasoningEffort
                      ? { reasoningEffort: selection.reasoningEffort }
                      : {}),
                  },
                ],
              },
            },
            'PUT',
          );
        }
      }
      setProgress(`Reviewer configured (${operation.current.seatId}). Admission pending.`);
      if (config.state === 'draft')
        config = await request<SymposiumConfig>(`${base}/activate`, {
          expectedRevision: config.revision,
          contextSourceRefs: [],
          profileSelections: { ...current.initialProfileSelections, [seatId]: profile },
          ...boundary,
        });
      current = await request<Status>(base);
      // Existing isolated sessions stay isolated; new anchors are admitted through the same host boundary.
      for (const id of [config.version === 2 ? config.anchorSeatId : config.seats[0].id, seatId]) {
        const membership = current.seats.find((seat) => seat.seatId === id)?.membership;
        if (membership?.state === 'active') continue;
        await request(`${base}/membership`, {
          seatId: id,
          action: membership?.state === 'suspended' ? 'restore' : 'admit',
          expectedGeneration: membership?.generation ?? 0,
          configRevision: config.revision,
          reason: 'Add reviewer',
          idempotencyKey: `${operation.current.key}:${id}`,
          ...boundary,
        });
      }
      setProgress(
        `Reviewer admitted. Context not queued (${seatId}). Retry uses this seat and the same package.`,
      );
      await request(`${base}/deliveries`, {
        sourceSeatId: null,
        recipientSeatIds: [seatId],
        originalContent: `Review request (read-only):\n${brief.trim()}${context.content ? `\n\n${context.content}` : ''}`,
        idempotencyKey: `${operation.current.key}:context`,
      });
      setDone(true);
      window.dispatchEvent(new Event('symposium-roster-changed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add reviewer');
      setStatus(await request<Status>(base).catch(() => null));
    } finally {
      setBusy(false);
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
        aria-label="Ask another agent"
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
          <h2>Ask another agent</h2>
          <button type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
        </header>
        {done ? (
          <>
            <p role="status">
              Reviewer added. The selected context is queued for approval in Director controls.
            </p>
            <button type="button" onClick={onClose}>
              Done
            </button>
            <button type="button" onClick={onAnother}>
              Add another reviewer
            </button>
          </>
        ) : (
          <>
            <p>Choose a saved profile and the account that will receive this review request.</p>
            <fieldset disabled={busy || locked}>
              <SymposiumProfilePicker
                compact
                value={profile}
                onChange={setProfile}
                disabled={busy}
              />
              <AccountModelPicker
                scope="symposium"
                sessionId={null}
                preferredModel=""
                onChange={setSelection}
                disabled={busy}
              />
              <label>
                Review package
                <textarea
                  value={brief}
                  onChange={(event) => setBrief(event.target.value)}
                  placeholder="Objective and acceptance criteria; repository instructions; current diff and relevant source; test results; selected decisions. Include only what this reviewer should receive."
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
                  <option value="independent">Independent — review package only</option>
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
                The selected account receives the review package and chosen context only after
                delivery approval. Shared workspace files remain governed by the read-only seat
                boundary.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I acknowledge shared artifacts and the selected provider account’s retention
                boundary.
              </label>
              {(crossAccount || !status?.config) && (
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
            {!status?.runtimeAvailable && (
              <p role="status">
                {status?.config
                  ? 'Verified provider runtime is unavailable. Your choices remain here.'
                  : 'Adding prepares an isolated roster. Stop ordinary execution first; provider admission still requires the verified runtime.'}
              </p>
            )}
            {progress && <p role="status">{progress}</p>}
            <button type="button" disabled={!ready || busy} onClick={() => void add()}>
              Add reviewer and queue context
            </button>
            {error && (
              <p role="alert">{error} Any configured seats remain visible in Director controls.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
