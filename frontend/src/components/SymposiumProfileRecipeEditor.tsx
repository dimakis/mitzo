import type { SymposiumProfileRecipe } from '@mitzo/protocol';

const providerLabels = {
  openai: 'OpenAI API',
  'openai-codex': 'ChatGPT subscription',
  'anthropic-vertex': 'Vertex Claude',
  'google-vertex': 'Vertex Gemini',
};
const initial: SymposiumProfileRecipe = {
  version: 1,
  context: { include: ['task', 'diff', 'acceptance-criteria'], sources: ['workspace'] },
  skillRefs: [],
  toolDefaults: { mode: 'read-only', preferredTools: [] },
  compatibleProviders: ['anthropic-vertex', 'google-vertex', 'openai-codex', 'openai'],
  reviewerTemplate: 'general',
};
const toggle = <T,>(values: T[], value: T): T[] =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

export function SymposiumProfileRecipeEditor({
  value,
  onChange,
  disabled,
}: {
  value: SymposiumProfileRecipe | undefined;
  onChange(value: SymposiumProfileRecipe | undefined): void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="symposium-profile-recipe" disabled={disabled}>
      <legend>Reusable review recipe</legend>
      <p>
        Setup guidance only. Select sources and confirm permissions for each review. Saving never
        changes an active seat.
      </p>
      <label>
        <input
          type="checkbox"
          checked={!!value}
          onChange={(event) => onChange(event.target.checked ? initial : undefined)}
        />
        Include reusable recipe
      </label>
      {value && (
        <>
          <label>
            Reviewer template
            <select
              value={value.reviewerTemplate}
              onChange={(event) =>
                onChange({
                  ...value,
                  reviewerTemplate: event.target
                    .value as SymposiumProfileRecipe['reviewerTemplate'],
                })
              }
            >
              {['general', 'architecture', 'security', 'testability', 'editorial'].map(
                (template) => (
                  <option key={template}>{template}</option>
                ),
              )}
            </select>
          </label>
          <fieldset>
            <legend>Suggested context</legend>
            {(['task', 'diff', 'acceptance-criteria', 'artifacts', 'prior-findings'] as const).map(
              (item) => (
                <label key={item}>
                  <input
                    type="checkbox"
                    checked={value.context.include.includes(item)}
                    onChange={() =>
                      onChange({
                        ...value,
                        context: { ...value.context, include: toggle(value.context.include, item) },
                      })
                    }
                  />
                  {item}
                </label>
              ),
            )}
            {(['workspace', 'contexgin'] as const).map((source) => (
              <label key={source}>
                <input
                  type="checkbox"
                  checked={value.context.sources.includes(source)}
                  onChange={() =>
                    onChange({
                      ...value,
                      context: { ...value.context, sources: toggle(value.context.sources, source) },
                    })
                  }
                />
                {source === 'contexgin' ? 'ContexGin (explicit selection required)' : 'Workspace'}
              </label>
            ))}
          </fieldset>
          <label>
            Skill references (one per line)
            <textarea
              value={value.skillRefs.join('\n')}
              onChange={(event) =>
                onChange({ ...value, skillRefs: event.target.value.split('\n') })
              }
            />
          </label>
          <label>
            Preferred read-only tools (one per line)
            <textarea
              value={value.toolDefaults.preferredTools.join('\n')}
              onChange={(event) =>
                onChange({
                  ...value,
                  toolDefaults: {
                    mode: 'read-only',
                    preferredTools: event.target.value.split('\n'),
                  },
                })
              }
            />
          </label>
          <p>References do not install skills, enable tools, or grant access.</p>
          <fieldset>
            <legend>Compatible providers</legend>
            {initial.compatibleProviders.map((provider) => (
              <label key={provider}>
                <input
                  type="checkbox"
                  checked={value.compatibleProviders.includes(provider)}
                  onChange={() =>
                    onChange({
                      ...value,
                      compatibleProviders: toggle(value.compatibleProviders, provider),
                    })
                  }
                />
                {providerLabels[provider]}
              </label>
            ))}
          </fieldset>
        </>
      )}
    </fieldset>
  );
}
