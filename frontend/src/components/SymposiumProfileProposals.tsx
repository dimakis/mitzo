import { SymposiumProfileRecipeEditor } from './SymposiumProfileRecipeEditor';
import './SymposiumProfilePicker.css';
import { useEffect, useRef, useState } from 'react';
import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';

type Proposal = {
  proposalId: string;
  suggestedProfileId: string | null;
  definition: SymposiumProfileDefinition;
  state: 'pending' | 'saved' | 'discarded';
};
export type SeatProfileSeed = {
  seatId: string;
  name: string;
  role: string;
  profileBinding?: { profileId: string; profileRevision: string };
};
const roles: SymposiumProfileDefinition['role'][] = [
  'planner',
  'architect',
  'coder',
  'reviewer',
  'research',
  'synthesis',
];
const roleForSeat = (role: string): SymposiumProfileDefinition['role'] =>
  role === 'implementer' || role === 'coder'
    ? 'coder'
    : roles.includes(role as SymposiumProfileDefinition['role'])
      ? (role as SymposiumProfileDefinition['role'])
      : 'synthesis';
const seedDefinition = (seat: SeatProfileSeed): SymposiumProfileDefinition => ({
  name: seat.name,
  role: roleForSeat(seat.role),
  instructions: '',
  expectedOutput: '',
  acceptanceCriteria: [''],
  modelPolicyRole: roleForSeat(seat.role),
});
async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body as T;
}
const headers = { 'Content-Type': 'application/json' };

function ProposalEditor({
  sessionId,
  proposal,
  seed,
  onDone,
}: {
  sessionId: string;
  proposal?: Proposal;
  seed?: SeatProfileSeed;
  onDone(): void;
}) {
  const [definition, setDefinition] = useState<SymposiumProfileDefinition>(
    proposal?.definition ?? seedDefinition(seed!),
  );
  const [profileId, setProfileId] = useState(
    proposal?.suggestedProfileId ??
      (seed?.profileBinding && !seed.profileBinding.profileId.startsWith('host-profile:')
        ? seed.profileBinding.profileId
        : ''),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<{ profileId: string; revision: number }[] | null>(null);
  const saveKey = useRef(crypto.randomUUID());

  useEffect(() => {
    let live = true;
    readJson<{ profileId: string; revision: number }[]>('/api/symposium/profiles')
      .then((rows) => {
        if (live) setCatalog(rows);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const binding = seed?.profileBinding;
    if (!binding || binding.profileId.startsWith('host-profile:')) return;
    let live = true;
    readJson<{ definition: SymposiumProfileDefinition }>(
      `/api/symposium/profiles/${encodeURIComponent(binding.profileId)}/${encodeURIComponent(binding.profileRevision)}`,
    )
      .then((version) => {
        if (live) setDefinition(version.definition);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [seed]);

  const update = <K extends keyof SymposiumProfileDefinition>(
    key: K,
    value: SymposiumProfileDefinition[K],
  ) => {
    saveKey.current = crypto.randomUUID();
    setDefinition((current) => ({ ...current, [key]: value }));
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const portableDefinition = definition.recipe
        ? {
            ...definition,
            recipe: {
              ...definition.recipe,
              skillRefs: definition.recipe.skillRefs.map((ref) => ref.trim()).filter(Boolean),
              toolDefaults: {
                ...definition.recipe.toolDefaults,
                preferredTools: definition.recipe.toolDefaults.preferredTools
                  .map((ref) => ref.trim())
                  .filter(Boolean),
              },
            },
          }
        : definition;
      if (!catalog) throw new Error('Profile catalog is not available');
      const expectedRevision = catalog.find((row) => row.profileId === profileId)?.revision ?? 0;
      if (proposal) {
        await readJson(
          `/api/symposium/profile-proposals/${encodeURIComponent(proposal.proposalId)}/save`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              sessionId,
              profileId,
              expectedRevision,
              definition: portableDefinition,
            }),
          },
        );
      } else {
        await readJson('/api/symposium/profiles', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            profileId,
            expectedRevision,
            idempotencyKey: saveKey.current,
            definition: portableDefinition,
          }),
        });
      }
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Profile save failed');
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!proposal) {
      onDone();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await readJson(
        `/api/symposium/profile-proposals/${encodeURIComponent(proposal.proposalId)}/discard`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ sessionId }),
        },
      );
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Proposal discard failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="symposium-profile-picker symposium-profile-proposal"
      aria-label={proposal ? 'Agent profile proposal' : 'Seat profile draft'}
    >
      <p>
        {proposal
          ? 'Agent draft for your review. Nothing is saved as a profile yet.'
          : 'Portable draft from this seat. Add guidance before saving; session instructions were not copied.'}
      </p>
      <label>
        Profile ID
        <input
          value={profileId}
          onChange={(event) => {
            saveKey.current = crypto.randomUUID();
            setProfileId(event.target.value);
          }}
        />
      </label>
      <label>
        Name
        <input value={definition.name} onChange={(event) => update('name', event.target.value)} />
      </label>
      <label>
        Role
        <select
          value={definition.role}
          onChange={(event) =>
            update('role', event.target.value as SymposiumProfileDefinition['role'])
          }
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </label>
      <label>
        Instructions
        <textarea
          value={definition.instructions}
          onChange={(event) => update('instructions', event.target.value)}
        />
      </label>
      <label>
        Expected output
        <textarea
          value={definition.expectedOutput}
          onChange={(event) => update('expectedOutput', event.target.value)}
        />
      </label>
      <label>
        Acceptance criteria
        <textarea
          value={definition.acceptanceCriteria.join('\n')}
          onChange={(event) =>
            update(
              'acceptanceCriteria',
              event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            )
          }
        />
      </label>
      <label>
        Model policy role
        <input
          value={definition.modelPolicyRole}
          onChange={(event) => update('modelPolicyRole', event.target.value)}
        />
      </label>
      <SymposiumProfileRecipeEditor
        value={definition.recipe}
        onChange={(recipe) => update('recipe', recipe)}
        disabled={busy}
      />
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={
          busy ||
          !catalog ||
          !profileId.trim() ||
          !definition.instructions.trim() ||
          !definition.expectedOutput.trim() ||
          definition.acceptanceCriteria.length === 0 ||
          !definition.modelPolicyRole.trim()
        }
        onClick={() => void save()}
      >
        Save reusable profile
      </button>
      <button type="button" disabled={busy} onClick={() => void discard()}>
        Discard draft
      </button>
    </section>
  );
}

/** Inline in the existing chat view, including before Symposium is enabled. */
export function SymposiumProfileProposals({
  sessionId,
  seatSeed,
  onSeatSeedDone,
}: {
  sessionId: string;
  seatSeed?: SeatProfileSeed | null;
  onSeatSeedDone?(): void;
}) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const refresh = () =>
      readJson<Proposal[]>(
        `/api/symposium/profile-proposals?sessionId=${encodeURIComponent(sessionId)}`,
      )
        .then((rows) => {
          if (!Array.isArray(rows)) throw new Error('Profile proposals response is invalid');
          if (live) {
            setProposals(rows);
            setError('');
          }
        })
        .catch((cause: unknown) => {
          if (live) setError(cause instanceof Error ? cause.message : String(cause));
        });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);
  const remove = (proposalId: string) =>
    setProposals((current) => current.filter((row) => row.proposalId !== proposalId));
  if (!seatSeed && proposals.length === 0 && !error) return null;
  return (
    <aside className="symposium-profile-proposals" aria-label="Reusable profile drafts">
      {error && <p role="alert">{error}</p>}
      {seatSeed && (
        <ProposalEditor
          key={`seat:${seatSeed.seatId}`}
          sessionId={sessionId}
          seed={seatSeed}
          onDone={() => onSeatSeedDone?.()}
        />
      )}
      {proposals.map((proposal) => (
        <ProposalEditor
          key={proposal.proposalId}
          sessionId={sessionId}
          proposal={proposal}
          onDone={() => remove(proposal.proposalId)}
        />
      ))}
    </aside>
  );
}
