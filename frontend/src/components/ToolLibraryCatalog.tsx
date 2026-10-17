import { useId } from 'react';
import {
  agentProfileLabel,
  type AgentLibraryCatalog,
  type AgentToolCatalogEntry,
} from '@mitzo/protocol';
import { EmptyState } from './EmptyState';
import { UiIcon, type UiIconName } from './UiIcon';
import '../styles/tool-library.css';

const behaviorLabels = {
  read: 'Read only',
  write: 'Writes',
  mixed: 'Read & write',
  interaction: 'Interaction',
};
const sourceIcons: Record<string, UiIconName> = {
  Workspace: 'terminal',
  Connections: 'connections',
  Repositories: 'worktree',
  'Agent Library': 'agents',
  Web: 'search',
  'GitHub publishing': 'upload',
  Telos: 'work',
};

export function ToolLibraryCatalog({
  tools,
  catalog,
  loaded,
  filters,
  onFiltersChange,
}: {
  tools: AgentToolCatalogEntry[];
  catalog: AgentLibraryCatalog | null;
  loaded: boolean;
  filters: { query: string; source: string };
  onFiltersChange(filters: { query: string; source: string }): void;
}) {
  const categoryId = useId();
  const { query, source } = filters;
  const sources = [...new Set(tools.map((tool) => tool.source))].sort();
  const visible = tools.filter(
    (tool) =>
      (!source || tool.source === source) &&
      `${tool.name} ${tool.id} ${tool.description} ${tool.source}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <div className="tool-library-catalog">
      <div className="tool-library-filters">
        <label className="tool-library-search">
          Search tool library
          <span>
            <UiIcon name="search" size={20} />
            <input
              type="search"
              placeholder="Search tools…"
              value={query}
              onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
            />
          </span>
        </label>
        <div className="tool-library-category">
          <label htmlFor={categoryId}>Category</label>
          <select
            id={categoryId}
            value={source}
            onChange={(event) => onFiltersChange({ ...filters, source: event.target.value })}
          >
            <option value="">All categories</option>
            {sources.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {loaded && (
        <p className="tool-library-count" aria-live="polite">
          {visible.length} {visible.length === 1 ? 'tool' : 'tools'}
          {source && ` in ${source}`}
        </p>
      )}
      <div className="tool-library-grid">
        {visible.map((tool) => {
          const profiles =
            catalog &&
            [...catalog.drafts, ...catalog.versions].filter((profile) =>
              profile.definition.tools?.some(
                (ref) =>
                  ref.id === tool.id &&
                  ref.version === tool.version &&
                  (!('revision' in ref) || ('revision' in tool && ref.revision === tool.revision)),
              ),
            );
          return (
            <article className="tool-library-card" key={tool.id}>
              <div className="tool-library-card-heading">
                <span className="tool-library-icon">
                  <UiIcon name={sourceIcons[tool.source] ?? 'box'} size={20} />
                </span>
                <div>
                  <span className="tool-library-source">{tool.source}</span>
                  <h2>{tool.name}</h2>
                </div>
              </div>
              <p className="tool-library-description">{tool.description}</p>
              <div className="tool-library-badges">
                <span>{behaviorLabels[tool.behavior]}</span>
                {tool.required && (
                  <span>
                    <UiIcon name="shield" size={16} />
                    Required
                  </span>
                )}
                {!tool.routes.includes('local-api') && (
                  <span>
                    <UiIcon name="unavailable" size={16} />
                    Selection unavailable
                  </span>
                )}
              </div>
              <details className="tool-library-details">
                <summary>
                  <span>Details</span>
                  <UiIcon name="down" size={16} />
                </summary>
                <div className="tool-library-facts">
                  <p>{tool.description}</p>
                  <dl>
                    <div>
                      <dt>Tool ID</dt>
                      <dd>
                        <code>{tool.id}</code> · v{tool.version}
                      </dd>
                    </div>
                    <div>
                      <dt>Availability</dt>
                      <dd>
                        {tool.routes.includes('local-api')
                          ? 'Local OpenAI Responses and Gemini/Vertex API chats'
                          : tool.requirement}
                      </dd>
                    </div>
                    <div>
                      <dt>Permissions</dt>
                      <dd>{tool.requirement}</dd>
                    </div>
                    {'revision' in tool && (
                      <div>
                        <dt>Catalog changes</dt>
                        <dd>New session required. Existing chats retain their admitted tools.</dd>
                      </div>
                    )}
                    <div>
                      <dt>Selection</dt>
                      <dd>{tool.required ? 'Required platform tool' : 'Optional profile tool'}</dd>
                    </div>
                  </dl>
                  {profiles && (
                    <details className="tool-library-usage">
                      <summary>Profiles using this tool</summary>
                      {profiles.map((profile) => (
                        <p
                          key={`${profile.profileId}:${'version' in profile ? 'draft' : profile.revision}`}
                        >
                          {agentProfileLabel(profile.definition)} ·{' '}
                          {'version' in profile ? 'Draft' : `r${profile.revision}`}
                        </p>
                      ))}
                      {!profiles.length && (
                        <p>No explicit references. Legacy profiles use their runtime catalog.</p>
                      )}
                    </details>
                  )}
                </div>
              </details>
            </article>
          );
        })}
      </div>
      {loaded && !visible.length && (
        <EmptyState
          icon={<UiIcon name="search" size={24} />}
          title={tools.length ? 'No matching tools' : 'No implemented tools are available.'}
          subtitle={tools.length ? 'Try another search or category.' : undefined}
        />
      )}
      {(query || source) && (
        <button
          type="button"
          onClick={() => {
            onFiltersChange({ query: '', source: '' });
          }}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
