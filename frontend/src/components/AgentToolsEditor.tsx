import { useRef, useState } from 'react';
import type { AgentToolCatalogEntry, AgentToolReference } from '@mitzo/protocol';
import { MotionPresence } from './MotionPresence';

export function AgentToolsEditor({
  tools,
  value,
  onChange,
  disabled,
}: {
  tools: AgentToolCatalogEntry[];
  value: AgentToolReference[] | undefined;
  onChange(value: AgentToolReference[] | undefined): void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const add = useRef<HTMLButtonElement>(null);
  const selected = value ?? [];
  return (
    <fieldset className="agent-library-fields" disabled={disabled}>
      <p>Choose tools for new local OpenAI Responses and Gemini/Vertex API chats.</p>
      <details>
        <summary>Runtime compatibility</summary>
        <p>
          Native Codex, OpenShell, Claude SDK and reviewer seats do not yet support explicit
          selections. Existing chats keep their original selection.
        </p>
      </details>
      {value === undefined ? (
        <>
          <p>
            Legacy behavior: this profile uses the runtime’s existing tool catalog. Choosing
            specific tools replaces that behavior for new chats.
          </p>
          <button type="button" onClick={() => onChange([])}>
            Choose specific tools
          </button>
        </>
      ) : (
        <>
          <p>
            {selected.length
              ? `${selected.length} optional tools selected`
              : 'No optional tools selected. Only required platform tools will be exposed.'}
          </p>
          <div className="agent-library-actions">
            <button type="button" ref={add} aria-expanded={open} onClick={() => setOpen(!open)}>
              Add tools
            </button>
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
            >
              Use legacy catalog
            </button>
          </div>
          {selected.map((ref) => {
            const entry = tools.find((tool) => tool.id === ref.id && tool.version === ref.version);
            return (
              <article className="agent-tool-row" key={ref.id}>
                <div>
                  <strong>{entry?.name ?? ref.id}</strong>
                  <p>
                    {entry?.description ??
                      'Tool version is missing from the installed catalog. New sessions will refuse admission.'}
                  </p>
                  <small>
                    {entry?.requirement ?? 'Unavailable tool reference'} · v{ref.version}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((tool) => tool.id !== ref.id))}
                  aria-label={`Remove ${entry?.name ?? ref.id}`}
                >
                  Remove
                </button>
              </article>
            );
          })}
          <MotionPresence open={open} kind="disclosure">
            <section
              className="agent-tool-picker"
              aria-label="Add existing tools"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setOpen(false);
                  add.current?.focus();
                }
              }}
            >
              <label>
                Search tools
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              {tools
                .filter(
                  (tool) =>
                    !tool.required &&
                    !selected.some((ref) => ref.id === tool.id) &&
                    `${tool.name} ${tool.description} ${tool.source}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                )
                .map((tool) => (
                  <article className="agent-tool-row" key={tool.id}>
                    <div>
                      <strong>{tool.name}</strong>
                      <p>{tool.description}</p>
                      <small>
                        {tool.source} · {tool.behavior} ·{' '}
                        {tool.routes.includes('local-api')
                          ? 'Local API chats'
                          : 'Unsupported route'}
                      </small>
                      <p>{tool.requirement}</p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Add ${tool.name}`}
                      disabled={!tool.routes.includes('local-api') || selected.length >= 100}
                      onClick={() =>
                        onChange([...selected, { id: tool.id, version: tool.version }])
                      }
                    >
                      Add
                    </button>
                  </article>
                ))}
              {!tools.some(
                (tool) =>
                  !tool.required &&
                  !selected.some((ref) => ref.id === tool.id) &&
                  `${tool.name} ${tool.description} ${tool.source}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
              ) && <p>No matching tools.</p>}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  add.current?.focus();
                }}
              >
                Done adding tools
              </button>
            </section>
          </MotionPresence>
        </>
      )}
      <section aria-label="Required platform tools">
        <h3>Required platform tools</h3>
        {tools
          .filter((tool) => tool.required)
          .map((tool) => (
            <p key={tool.id}>
              <strong>{tool.name}</strong> · {tool.description}
            </p>
          ))}
      </section>
      <p>
        Selection grants no access. Connections, credentials, approvals and revocation remain
        authoritative. Configure missing connections in Connections. Active runtimes cannot refresh
        this catalog; start a new chat after publishing changes.
      </p>
    </fieldset>
  );
}
