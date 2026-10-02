import { createPortal } from 'react-dom';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  SymposiumConfig,
  SymposiumProfileDefinition,
  ValidAccountBinding,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { AccountModelPicker, type AccountSelection } from './AccountModelPicker';
import { SymposiumProfilePicker, type SymposiumProfileSelection } from './SymposiumProfilePicker';
import './AddReviewerSheet.css';

type Status = {
  config: SymposiumConfig | null;
  ordinaryAccountId?: string | null;
  runtimeAvailable: boolean;
  initialProfileSelections?: Record<string, SymposiumProfileSelection>;
  seats: { seatId: string; membership: { state: string; generation: number } | null }[];
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
  if (!response.ok)
    throw new ReviewerRequestError(
      result.error || 'Agent request failed',
      result.seatMutation === 'not-started',
    );
  return result as T;
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
            onAnother={() => setAttempt((value) => value + 1)}
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
  const [name, setName] = useState('');
  const [role, setRole] = useState('agent');
  const [instructions, setInstructions] = useState('');
  const [expectedOutput, setExpectedOutput] = useState('');
  const [criteria, setCriteria] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);
  const profileLoad = useRef(0);
  const [authority, setAuthority] = useState({
    filesystem: 'read',
    tools: 'read',
    network: 'restricted',
  } as {
    filesystem: 'read' | 'write';
    tools: 'read' | 'write';
    network: 'restricted';
  });
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
  const [locked, updateLocked] = useState(false);
  const lockedRef = useRef(false);
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
  }, [base, open]);
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
    (!status.config || status.runtimeAvailable) &&
    (generic
      ? name.trim() &&
        /^[a-z][a-z0-9_-]{0,63}$/.test(role) &&
        instructions.trim() &&
        expectedOutput.trim() &&
        criteria.trim() &&
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
    if (!ready || !selection || (!generic && !profile) || busy) return;
    setBusy(true);
    setProgress('Preparing the agent and its message context…');
    setError('');
    let reviewerMutationAttempted = false;
    try {
      const selectedProfile =
        !generic && profile
          ? await request<{ definition: { role: string } }>(
              `/api/symposium/profiles/${encodeURIComponent(profile.profileId)}/${profile.revision}`,
            )
          : null;
      if (!generic && selectedProfile?.definition?.role !== 'reviewer')
        throw new Error('Choose a profile with the reviewer role.');
      const context =
        packageSnapshot.current ??
        (await request<{ content: string }>(`${base}/context-package`, {
          mode,
          ...(mode === 'summary' ? { summary } : {}),
          ...(mode === 'selected-turns' ? { turnIds } : {}),
        }));
      let current = await request<Status>(base);
      let config = current.config;
      if (!config) {
        setStatus(current);
        if (!current.ordinaryAccountId)
          throw new Error('Conversation account binding is unavailable');
        if (current.ordinaryAccountId !== selection.accountId && typed !== confirmation)
          throw new Error('Confirm the cross-account transfer before binding the agent');
        config = await request<SymposiumConfig>(`${base}/draft`, {
          expectedAccountId: current.ordinaryAccountId,
        });
      }
      if (config.version !== 2)
        throw new Error('This roster must be upgraded before adding an agent');
      const configuredAnchorId = config.anchorSeatId;
      const configuredAnchor = config.seats.find((seat) => seat.id === configuredAnchorId);
      if (
        configuredAnchor?.accountBinding &&
        configuredAnchor.accountBinding.accountId !== selection.accountId &&
        typed !== confirmation
      )
        throw new Error('Confirm the cross-account transfer before binding the agent');
      packageSnapshot.current = context;
      setLocked(true);
      const boundary = {
        sharedBoundaryAcknowledged: true,
        ...(typed === confirmation ? { crossAccountConfirmation: confirmation } : {}),
      };
      const seatId = operation.current.seatId;
      const guidance = generic
        ? {
            name: name.trim(),
            role,
            systemPrompt: instructions.trim(),
            expectedOutput: expectedOutput.trim(),
            acceptanceCriteria: criteria
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
            authorityRequest: authority,
          }
        : { name: 'Reviewer', role: 'reviewer', systemPrompt: '' };
      reviewerMutationAttempted = config.seats.some((seat) => seat.id === seatId);
      if (!reviewerMutationAttempted) {
        if (config.state === 'active') {
          reviewerMutationAttempted = true;
          config = await request<SymposiumConfig>(`${base}/seats/revise`, {
            expectedRevision: config.revision,
            seatId,
            ...guidance,
            color: '#665599',
            accountId: selection.accountId,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
            ...(!generic && profile ? { profileSelection: profile } : {}),
            contextSourceRefs: [],
            ...boundary,
          });
        } else {
          const { binding } = await request<{ binding: ValidAccountBinding }>(`${base}/selection`, {
            accountId: selection.accountId,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          });
          reviewerMutationAttempted = true;
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
                    ...guidance,
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
      setProgress(
        `${generic ? 'Agent' : 'Reviewer'} configured (${operation.current.seatId}). Admission pending.`,
      );
      if (config.state === 'draft')
        config = await request<SymposiumConfig>(`${base}/activate`, {
          expectedRevision: config.revision,
          contextSourceRefs: [],
          profileSelections: {
            ...current.initialProfileSelections,
            ...(!generic && profile ? { [seatId]: profile } : {}),
          },
          ...boundary,
        });
      setProgress(
        'Connecting agent — checking its account and workspace access. This may take several minutes.',
      );
      await request(`${base}/admissions/refresh`, { expectedRevision: config.revision });
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
          reason: generic ? 'Add agent' : 'Add reviewer',
          idempotencyKey: `${operation.current.key}:${id}`,
          ...boundary,
        });
      }
      setProgress(
        `${generic ? 'Agent' : 'Reviewer'} admitted. Context not queued (${seatId}). Retry uses this seat and the same package.`,
      );
      await request(`${base}/deliveries`, {
        sourceSeatId: null,
        recipientSeatIds: [seatId],
        originalContent: `${generic ? 'Agent request:' : 'Review request (read-only):'}\n${brief.trim()}${context.content ? `\n\n${context.content}` : ''}`,
        idempotencyKey: `${operation.current.key}:context`,
      });
      setDone(true);
      window.dispatchEvent(new Event('symposium-roster-changed'));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : generic
            ? 'Could not add agent'
            : 'Could not add reviewer',
      );
      const refreshed = await request<Status>(base).catch(() => null);
      setStatus(refreshed);
      // Absence alone does not exclude an in-flight write after a lost response.
      if (
        !locked &&
        refreshed &&
        !refreshed.config?.seats.some((seat) => seat.id === operation.current.seatId) &&
        (!reviewerMutationAttempted ||
          (cause instanceof ReviewerRequestError && cause.noSeatMutation))
      ) {
        setLocked(false);
        packageSnapshot.current = null;
        setProgress('');
      }
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
                ? 'Define an agent and choose its account. A saved profile can supply guidance; permissions are chosen here.'
                : 'Choose a saved profile and the account that will receive this review request.'}
            </p>
            <fieldset disabled={busy || locked}>
              {generic && <h3>Guidance</h3>}
              {generic && (
                <p>
                  Load a saved profile to copy its versioned guidance into this form. Edits apply to
                  this agent only; account and permissions are selected separately.
                </p>
              )}
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
              {generic && (
                <>
                  <fieldset disabled={profileLoading}>
                    <label>
                      Agent name
                      <input value={name} onChange={(event) => setName(event.target.value)} />
                    </label>
                    <label>
                      Agent role
                      <input
                        value={role}
                        onChange={(event) => setRole(event.target.value)}
                        pattern="[a-z][a-z0-9_-]{0,63}"
                      />
                    </label>
                    <label>
                      Agent instructions
                      <textarea
                        value={instructions}
                        onChange={(event) => setInstructions(event.target.value)}
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
                  </fieldset>
                  {profileLoading && <p role="status">Loading saved guidance…</p>}
                </>
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
                  <p>
                    Network access is restricted. The host verifies the requested permissions before
                    admitting the agent.
                  </p>
                </>
              )}
              {generic && <h3>Message and context</h3>}
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
                The selected account receives the initial message and chosen context after delivery
                approval. Shared workspace access follows the seat permissions.
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
            {!status?.runtimeAvailable && (
              <p role="status">
                {status?.config
                  ? 'Verified provider runtime is unavailable. Your choices remain here.'
                  : 'Adding prepares an isolated roster. Stop ordinary execution first; provider admission still requires the verified runtime.'}
              </p>
            )}
            {progress && <p role="status">{progress}</p>}
            <button
              className="btn-primary"
              type="button"
              disabled={!ready || busy}
              onClick={() => void add()}
            >
              {busy
                ? 'Connecting agent…'
                : generic
                  ? 'Add agent and queue message'
                  : 'Add reviewer and queue context'}
            </button>
            {error && (
              <p role="alert">{error} Any configured seats remain visible in Agent settings.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
