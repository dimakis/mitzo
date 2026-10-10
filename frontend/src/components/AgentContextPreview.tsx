import type { CompiledAgentContext } from '@mitzo/protocol';

export function AgentContextPreview({ value }: { value: CompiledAgentContext }) {
  const context = value.context;
  return (
    <div className="agent-library-context-preview">
      <p>
        {context.tokenCount.toLocaleString()} / {context.tokenBudget.toLocaleString()} tokens ·{' '}
        {context.sourceCount} {context.sourceCount === 1 ? 'source' : 'sources'}
      </p>
      <p>
        {value.source === 'workspace'
          ? 'Preview uses the configured workspace. Each new chat compiles its own workspace; resumes reuse their saved context.'
          : 'Preview uses the configured ContexGin preset. Each new chat saves the compiled result for later resumes.'}
      </p>
      <details>
        <summary>Sources and trimming</summary>
        <ul>
          {context.sources.map((source) => (
            <li key={source.path}>
              <code>{source.path}</code>
            </li>
          ))}
        </ul>
        {value.source === 'workspace' ? (
          <>
            <p>
              {context.trimmed.length} optional{' '}
              {context.trimmed.length === 1 ? 'section' : 'sections'} trimmed.
            </p>
            {context.trimmed.length > 0 && (
              <ul>
                {context.trimmed.map((section, index) => (
                  <li key={`${section.source}:${index}`}>
                    {section.heading} · {section.tokens.toLocaleString()} tokens
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p>
            This preset reports sources and token use; section trimming details are unavailable.
          </p>
        )}
        <p>
          Context reference: <code>{value.payloadHash}</code>
        </p>
      </details>
    </div>
  );
}
