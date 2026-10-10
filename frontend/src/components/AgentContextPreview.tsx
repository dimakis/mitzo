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
          ? 'Preview uses the configured sample workspace. New chats compile their own task workspace; resumes keep the saved recipe.'
          : value.source === 'packs'
            ? 'Preview uses pinned accepted Knowledge revisions. Each new chat saves this exact compiled result; existing chats retain their snapshot.'
            : 'Preview uses the configured ContexGin preset. Sandbox chats use its configured sandbox recipe, so their sources can differ from this preview.'}
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
        {value.source !== 'contexgin' ? (
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
        {value.provenance && (
          <>
            <h3>Pinned packs</h3>
            <ul>
              {value.provenance.packs.map((pack) => (
                <li key={`${pack.id}:${pack.revision}`}>
                  <p>
                    {pack.id} · revision {pack.revision}
                  </p>
                  <code>{pack.hash}</code>
                </li>
              ))}
            </ul>
            <h3>Accepted source revisions</h3>
            <ul>
              {value.provenance.documents.map((document) => (
                <li key={`${document.path}:${document.revision}`}>
                  <p>
                    {document.path} · {document.storeId}
                  </p>
                  <code>{document.revision}</code>
                  <p>
                    Content hash: <code>{document.contentHash}</code>
                  </p>
                </li>
              ))}
            </ul>
            <h3>Omitted sections</h3>
            {value.provenance.omissions.length ? (
              <ul>
                {value.provenance.omissions.map((section, index) => (
                  <li key={index}>
                    {section.path} · {section.heading} · {section.reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No sections omitted.</p>
            )}
          </>
        )}
        <p>
          Compiler: <code>{value.compilerRevision}</code>
        </p>
        <p>
          Recipe reference: <code>{value.recipeHash}</code>
        </p>
        <p>
          Context reference: <code>{value.payloadHash}</code>
        </p>
      </details>
    </div>
  );
}
