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
  return (
    <fieldset className="agent-library-context-recipe" disabled={disabled}>
      <legend>Compiled chat context</legend>
      <p>
        Compile documents for local chats. OpenShell and Symposium keep their existing context
        setup.
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
                  event.target.value === 'workspace'
                    ? structuredClone(workspaceRecipe)
                    : { version: 1, source: 'contexgin', agentName: 'mitzo-conversational' },
                )
              }
            >
              <option value="workspace">Workspace documents</option>
              <option value="contexgin">ContexGin preset</option>
            </select>
          </label>
          {value.source === 'workspace' ? (
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
                Use relative Markdown paths in the chat workspace. AGENTS.md is always included;
                CLAUDE.md is used when AGENTS.md is absent.
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
              <p>Use a preset configured in ContexGin. Its recipe sets the sources and budget.</p>
            </>
          )}
        </>
      )}
    </fieldset>
  );
}
