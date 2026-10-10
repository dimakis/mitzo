import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';
import type { PublishedContextPack } from '@mitzo/protocol';
import type { AgentContextRecipe } from '@mitzo/protocol';

const workspaceRecipe: AgentContextRecipe = {
  version: 1,
  source: 'workspace',
  files: ['README.md'],
  tokenBudget: 12000,
  required: [],
  excluded: [],
};
const lines = (selectors: string[][]) =>
  selectors.map((selector) => selector.join(' > ')).join('\n');
const selectors = (value: string) => value.split('\n').map((line) => line.split(' > '));

export function AgentContextRecipeEditor({
  value,
  onChange,
  disabled,
}: {
  value: AgentContextRecipe | undefined;
  onChange(value: AgentContextRecipe | undefined): void;
  disabled?: boolean;
}) {
  const [packs, setPacks] = useState<PublishedContextPack[]>([]);
  const [packKey, setPackKey] = useState('');
  const [pinnedPacks, setPinnedPacks] = useState<Record<string, PublishedContextPack>>({});
  const [pinErrors, setPinErrors] = useState<Record<string, string>>({});
  const pinsKey = value?.source === 'packs' ? JSON.stringify(value.packs) : '';
  useEffect(() => {
    if (!pinsKey) return;
    let live = true;
    const pins: { id: string; revision: number; hash: string }[] = JSON.parse(pinsKey);
    void Promise.all(
      pins.map(async (pin) => {
        const key = `${pin.id}:${pin.revision}`;
        try {
          const response = await apiFetch(
            `/api/context-packs/${encodeURIComponent(pin.id)}/revisions/${pin.revision}`,
          );
          const result = await response.json();
          if (
            !response.ok ||
            result.pack?.id !== pin.id ||
            result.pack?.revision !== pin.revision ||
            result.pack?.hash !== pin.hash
          )
            throw Error('Pinned revision unavailable or hash mismatch');
          if (live) {
            setPinnedPacks((current) => ({ ...current, [key]: result.pack }));
            setPinErrors((current) => {
              const next = { ...current };
              delete next[key];
              return next;
            });
          }
        } catch (cause) {
          if (live) {
            setPinErrors((current) => ({
              ...current,
              [key]: cause instanceof Error ? cause.message : 'Pinned revision unavailable',
            }));
            setPinnedPacks((current) => {
              const next = { ...current };
              delete next[key];
              return next;
            });
          }
        }
      }),
    );
    return () => {
      live = false;
    };
  }, [pinsKey]);
  const [packError, setPackError] = useState('');
  useEffect(() => {
    if (value?.source !== 'packs') return;
    let live = true;
    apiFetch('/api/context-packs')
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.packs))
          throw Error(result.error || 'Context packs unavailable');
        if (live) {
          setPacks(result.packs);
          setPackError('');
        }
      })
      .catch((cause) => {
        if (live) setPackError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [value?.source]);
  const selectedPack =
    packs.find((item) => `${item.definition.id}:${item.revision}` === packKey) || packs[0];
  const alreadyPinned =
    value?.source === 'packs' &&
    !!selectedPack &&
    value.packs.some((item) => item.id === selectedPack.definition.id);
  return (
    <fieldset className="agent-library-context-recipe" disabled={disabled}>
      <legend>Compiled chat context</legend>
      <p>
        Published packs support local chats, OpenShell and Symposium seats that support compiled
        context. Workspace documents and ContexGin presets compile context for local chats and
        supported OpenShell sandboxes. Symposium uses published packs with its existing context and
        grant setup. Native Claude Symposium seats require a profile without a context recipe.
        Ordinary Claude chats support published packs.
      </p>
      <label className="agent-library-checkbox">
        <input
          type="checkbox"
          disabled={disabled}
          checked={!!value}
          onChange={(event) =>
            onChange(event.target.checked ? structuredClone(workspaceRecipe) : undefined)
          }
        />
        Compile chat context
      </label>
      {value && (
        <>
          <label>
            Context source
            <select
              value={value.source}
              onChange={(event) =>
                onChange(
                  event.target.value === 'packs'
                    ? { version: 2, source: 'packs', packs: [], tokenBudget: 12000 }
                    : event.target.value === 'workspace'
                      ? structuredClone(workspaceRecipe)
                      : { version: 1, source: 'contexgin', agentName: 'mitzo-conversational' },
                )
              }
            >
              <option value="packs">Published context packs</option>
              <option value="workspace">Workspace documents</option>
              <option value="contexgin">ContexGin preset</option>
            </select>
          </label>
          {value.source === 'packs' ? (
            <>
              <p>
                Manage reusable source choices in{' '}
                <a href="/knowledge?view=context">Knowledge → Context</a>. Each choice pins an
                immutable revision.
              </p>
              {packError && <p role="alert">{packError}</p>}
              <label>
                Published context pack
                <select
                  value={
                    packKey || (packs[0] ? `${packs[0].definition.id}:${packs[0].revision}` : '')
                  }
                  onChange={(event) => setPackKey(event.target.value)}
                >
                  {packs.map((pack) => (
                    <option
                      key={`${pack.definition.id}:${pack.revision}`}
                      value={`${pack.definition.id}:${pack.revision}`}
                    >
                      {pack.definition.name} · revision {pack.revision}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!selectedPack || alreadyPinned}
                onClick={() => {
                  const pack = selectedPack;
                  if (pack && !value.packs.some((item) => item.id === pack.definition.id))
                    onChange({
                      ...value,
                      packs: [
                        ...value.packs,
                        { id: pack.definition.id, revision: pack.revision, hash: pack.hash },
                      ],
                    });
                }}
              >
                Add pack revision
              </button>
              {alreadyPinned && (
                <p>Remove the existing pin before choosing another revision of this pack.</p>
              )}
              {value.packs.map((pack, index) => (
                <div key={`${pack.id}:${pack.revision}`}>
                  {pinnedPacks[`${pack.id}:${pack.revision}`] && (
                    <p>
                      {pinnedPacks[`${pack.id}:${pack.revision}`].definition.name} · revision{' '}
                      {pack.revision}
                    </p>
                  )}
                  {pinErrors[`${pack.id}:${pack.revision}`] && (
                    <p role="alert">{pinErrors[`${pack.id}:${pack.revision}`]}</p>
                  )}
                  <p>
                    {pack.id} · revision {pack.revision}
                  </p>
                  <code>{pack.hash}</code>
                  <button
                    type="button"
                    onClick={() =>
                      onChange({ ...value, packs: value.packs.filter((_, i) => i !== index) })
                    }
                  >
                    Remove {pack.id}
                  </button>
                </div>
              ))}
              {!packs.length && !packError && <p>No published context packs are available.</p>}
              <label>
                Token budget
                <input
                  type="number"
                  min={256}
                  max={32000}
                  value={value.tokenBudget || ''}
                  onChange={(event) =>
                    onChange({ ...value, tokenBudget: Number(event.target.value) })
                  }
                />
              </label>
            </>
          ) : value.source === 'workspace' ? (
            <>
              <label>
                Documents (one per line)
                <textarea
                  rows={3}
                  value={value.files.join('\n')}
                  placeholder="README.md&#10;docs/architecture.md"
                  onChange={(event) =>
                    onChange({ ...value, files: event.target.value.split('\n') })
                  }
                />
              </label>
              <p>
                Use relative Markdown paths in the chat's task workspace, including sandboxes.
                AGENTS.md is always included; CLAUDE.md is used when AGENTS.md is absent.
              </p>
              <label>
                Token budget
                <input
                  type="number"
                  min={256}
                  max={32000}
                  step={1}
                  value={value.tokenBudget || ''}
                  onChange={(event) =>
                    onChange({ ...value, tokenBudget: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Required sections (one per line)
                <textarea
                  rows={3}
                  value={lines(value.required)}
                  placeholder="docs/architecture.md > Design > Decisions"
                  onChange={(event) =>
                    onChange({ ...value, required: selectors(event.target.value) })
                  }
                />
              </label>
              <label>
                Excluded sections (one per line)
                <textarea
                  rows={3}
                  value={lines(value.excluded)}
                  placeholder="docs/architecture.md > Design > Background"
                  onChange={(event) =>
                    onChange({ ...value, excluded: selectors(event.target.value) })
                  }
                />
              </label>
              <p>
                Required sections must fit the budget. Optional sections may be trimmed; workspace
                instructions are preserved.
              </p>
            </>
          ) : (
            <>
              <label>
                ContexGin preset
                <input
                  value={value.agentName}
                  maxLength={64}
                  onChange={(event) => onChange({ ...value, agentName: event.target.value })}
                />
              </label>
              <p>
                Use a preset configured in ContexGin. OpenShell also requires this preset to be
                configured for sandbox documents. Its recipe sets the sources and budget.
              </p>
            </>
          )}
        </>
      )}
    </fieldset>
  );
}
