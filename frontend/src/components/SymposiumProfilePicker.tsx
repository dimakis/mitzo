import { useEffect, useState } from 'react';
import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { SymposiumProfileRecipeEditor } from './SymposiumProfileRecipeEditor';
import { symposiumProfileTemplates } from '../lib/symposium-profile-templates';
import './SymposiumProfilePicker.css';
import { apiFetch } from '../lib/api-fetch';

export interface SymposiumProfileSelection {
  profileId: string;
  revision: number;
}
interface Version extends SymposiumProfileSelection {
  definition: SymposiumProfileDefinition;
  contentHash: string;
}
interface Props {
  value: SymposiumProfileSelection | null;
  onChange(value: SymposiumProfileSelection | null): void;
  disabled?: boolean;
  compact?: boolean;
}
const empty: SymposiumProfileDefinition = {
  name: '',
  role: 'reviewer',
  instructions: '',
  expectedOutput: '',
  acceptanceCriteria: [''],
  modelPolicyRole: '',
};
const roles: SymposiumProfileDefinition['role'][] = [
  'planner',
  'architect',
  'coder',
  'reviewer',
  'research',
  'synthesis',
];

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || 'Profile request failed');
  return body as T;
}

/** Portable guidance picker. Account, context and authority are selected elsewhere. */
export function SymposiumProfilePicker({
  value,
  onChange,
  disabled = false,
  compact = false,
}: Props) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [editing, setEditing] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [expectedRevision, setExpectedRevision] = useState(0);
  const [definition, setDefinition] = useState<SymposiumProfileDefinition>(empty);
  const [importJson, setImportJson] = useState('');
  const [exportJson, setExportJson] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    apiFetch('/api/symposium/profiles')
      .then(readJson<Version[]>)
      .then((rows) => {
        if (live) setVersions(rows);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, []);

  const selected = versions.find(
    (version) => version.profileId === value?.profileId && version.revision === value.revision,
  );
  const isHistorical =
    selected &&
    versions.some(
      (version) => version.profileId === selected.profileId && version.revision > selected.revision,
    );
  const update = <K extends keyof SymposiumProfileDefinition>(
    key: K,
    field: SymposiumProfileDefinition[K],
  ) => setDefinition((current) => ({ ...current, [key]: field }));
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await readJson<Version>(
        await apiFetch('/api/symposium/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId,
            expectedRevision,
            idempotencyKey: crypto.randomUUID(),
            definition: definition.recipe
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
              : definition,
          }),
        }),
      );
      setVersions((current) => [
        ...current.filter(
          (row) => row.profileId !== saved.profileId || row.revision !== saved.revision,
        ),
        saved,
      ]);
      onChange({ profileId: saved.profileId, revision: saved.revision });
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const importVersion = async () => {
    setBusy(true);
    setError('');
    try {
      const artifact = JSON.parse(importJson) as unknown;
      const saved = await readJson<Version>(
        await apiFetch('/api/symposium/profiles/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artifact, idempotencyKey: crypto.randomUUID() }),
        }),
      );
      setVersions((current) => [
        ...current.filter(
          (row) => row.profileId !== saved.profileId || row.revision !== saved.revision,
        ),
        saved,
      ]);
      onChange({ profileId: saved.profileId, revision: saved.revision });
      setImportJson('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const exportVersion = async () => {
    if (!value) return;
    setError('');
    try {
      const version = await readJson<Version>(
        await apiFetch(
          `/api/symposium/profiles/${encodeURIComponent(value.profileId)}/${value.revision}/export`,
        ),
      );
      setExportJson(JSON.stringify(version, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="symposium-profile-picker" aria-label="Portable Symposium profile">
      <label>
        Saved profile
        <select
          disabled={disabled || busy}
          value={value ? `${value.profileId}:${value.revision}` : ''}
          onChange={(event) => {
            const version = versions.find(
              (row) => `${row.profileId}:${row.revision}` === event.target.value,
            );
            onChange(version ? { profileId: version.profileId, revision: version.revision } : null);
          }}
        >
          <option value="">Use seat guidance</option>
          {versions.map((version) => (
            <option
              key={`${version.profileId}:${version.revision}`}
              value={`${version.profileId}:${version.revision}`}
            >
              {version.definition.name} · v{version.revision}
            </option>
          ))}
        </select>
      </label>
      <details open={compact ? undefined : true}>
        <summary hidden={!compact}>Manage profiles</summary>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => {
            setProfileId('');
            setExpectedRevision(0);
            setDefinition(empty);
            setEditing(true);
          }}
        >
          New profile
        </button>
        <button
          type="button"
          disabled={disabled || busy || !selected || isHistorical}
          onClick={() => {
            if (!selected) return;
            setProfileId(selected.profileId);
            setExpectedRevision(selected.revision);
            setDefinition(selected.definition);
            setEditing(true);
          }}
        >
          Revise selected
        </button>
        {isHistorical && <p>Select the latest revision to revise this profile.</p>}
        <button type="button" disabled={disabled || !value} onClick={exportVersion}>
          Export JSON
        </button>
        {exportJson && (
          <textarea aria-label="Portable profile export" readOnly value={exportJson} />
        )}
        <label>
          Import profile JSON
          <textarea
            disabled={disabled || busy}
            value={importJson}
            onChange={(event) => setImportJson(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={disabled || busy || !importJson.trim()}
          onClick={importVersion}
        >
          Import profile
        </button>
        {editing && (
          <div>
            {expectedRevision === 0 && (
              <label>
                Start from template
                <select
                  defaultValue=""
                  onChange={(event) => {
                    const template = symposiumProfileTemplates.find(
                      (item) => item.id === event.target.value,
                    );
                    if (template) {
                      setDefinition(template.definition);
                      setProfileId(`${template.id}-reviewer`);
                    } else {
                      setDefinition(empty);
                      setProfileId('');
                    }
                  }}
                >
                  <option value="">Custom profile</option>
                  {symposiumProfileTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.definition.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p>
              Account: ask when seated. Save creates a catalog revision; apply it explicitly to a
              seat.
            </p>
            <label>
              Profile ID
              <input
                disabled={expectedRevision > 0}
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
              />
            </label>
            <label>
              Name
              <input
                value={definition.name}
                onChange={(event) => update('name', event.target.value)}
              />
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
              disabled={disabled || busy}
            />
            <button type="button" disabled={disabled || busy} onClick={save}>
              Save profile
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        )}
      </details>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
