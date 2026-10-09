import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { SymposiumProfileRecipeEditor } from './SymposiumProfileRecipeEditor';

export function AgentProfileEditor({
  value,
  onChange,
  tab,
  disabled,
}: {
  value: SymposiumProfileDefinition;
  onChange(value: SymposiumProfileDefinition): void;
  tab: 'identity' | 'instructions' | 'context';
  disabled: boolean;
}) {
  const update = <K extends keyof SymposiumProfileDefinition>(
    key: K,
    field: SymposiumProfileDefinition[K],
  ) => onChange({ ...value, [key]: field });
  return (
    <fieldset className="agent-library-fields" disabled={disabled}>
      {tab === 'identity' && (
        <>
          <div className="agent-library-field-pair">
            <label>
              Agent name
              <input
                maxLength={80}
                value={value.name}
                placeholder="Bob"
                onChange={(e) => update('name', e.target.value)}
              />
            </label>
            <label>
              Descriptor
              <input
                maxLength={80}
                value={value.descriptor ?? ''}
                placeholder="The architect"
                onChange={(e) => update('descriptor', e.target.value)}
              />
            </label>
          </div>
          <label>
            Description
            <textarea
              rows={3}
              maxLength={500}
              value={value.description ?? ''}
              placeholder="When should someone use this agent?"
              onChange={(e) => update('description', e.target.value)}
            />
          </label>
          <label>
            Role
            <input
              value={value.role}
              pattern="[a-z][a-z0-9_-]{0,63}"
              placeholder="agent, reviewer, writer…"
              onChange={(e) =>
                onChange({ ...value, role: e.target.value, modelPolicyRole: e.target.value })
              }
            />
          </label>
        </>
      )}
      {tab === 'instructions' && (
        <>
          <label>
            Behavior and instructions
            <textarea
              rows={8}
              value={value.instructions}
              onChange={(e) => update('instructions', e.target.value)}
            />
          </label>
          <label>
            Expected output
            <textarea
              rows={3}
              value={value.expectedOutput}
              onChange={(e) => update('expectedOutput', e.target.value)}
            />
          </label>
          <label>
            Acceptance criteria
            <textarea
              rows={3}
              value={value.acceptanceCriteria.join('\n')}
              onChange={(e) =>
                update(
                  'acceptanceCriteria',
                  e.target.value
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
        </>
      )}
      {tab === 'context' && (
        <SymposiumProfileRecipeEditor
          value={value.recipe}
          onChange={(recipe) => update('recipe', recipe)}
          disabled={disabled}
        />
      )}
    </fieldset>
  );
}
