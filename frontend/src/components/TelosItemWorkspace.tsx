import { TodoPrioritySelect } from './TodoPrioritySelect';
import type { TodoPrioritySaveState } from '../lib/todo-priority-save-state';
import { todoPriority } from '../lib/todo-utils';
import { setTodoPriority } from '../lib/todo-priority';
import { useState } from 'react';
import type { TelosWorkItem } from '@mitzo/protocol';
import { UiIcon } from './UiIcon';
import { TelosOutcomesTree } from './TelosOutcomesTree';
import { telosKindLabel } from '../lib/telos-kind-label';
import { TelosItemRoleEntries } from './TelosItemRoleEntries';
import { TelosItemChatTab } from './TelosItemChatTab';
import { TelosItemSources } from './TelosItemSources';
import { WorkOutputs } from './WorkOutputs';
import { SavedArtifactRouteDialog } from './SavedArtifactRouteDialog';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { artifactViewerUrl } from '../lib/file-paths';
import './TelosWorkspace.css';

type Tab = 'Overview' | 'Chat' | 'Work' | 'Materials';
function initialTab(key: string, search: string): Tab {
  const requested = new URLSearchParams(search).get('view');
  if (['Overview', 'Chat', 'Work', 'Materials'].includes(requested ?? '')) return requested as Tab;
  try {
    const saved = sessionStorage.getItem(key);
    if (['Overview', 'Chat', 'Work', 'Materials'].includes(saved ?? '')) return saved as Tab;
  } catch {
    /* optional preference */
  }
  return 'Overview';
}
const date = (value: string | null) => value ?? 'Unknown';
/** Accepted record display. Ordinary roles, sources and retained bytes keep
 * their existing owners; Chat is only their workspace entry point (S8 owns chooser). */
export function TelosItemWorkspace({
  record,
  records,
  refreshKey,
  onOpen,
  onBack,
  relatedState = 'ready',
  onRefresh,
  prioritySaveState,
}: {
  record: TelosWorkItem;
  records: TelosWorkItem[];
  refreshKey: string | number;
  onOpen(id: string, view?: 'Chat'): void;
  onBack(): void;
  relatedState?: 'loading' | 'unavailable' | 'ready';
  onRefresh?(): void;
  prioritySaveState?: TodoPrioritySaveState;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const key = 'telos.item.tab.' + record.itemId;
  const [tab, setTab] = useState<Tab>(() => initialTab(key, location.search));
  const [error, setError] = useState('');
  const descendants = new Set([record.itemId]);
  for (let i = 0; i < records.length; i++)
    for (const r of records)
      if (r.parentId && descendants.has(r.parentId)) descendants.add(r.itemId);
  const children = records.filter((r) => r.itemId !== record.itemId && descendants.has(r.itemId));
  const parent = records.find((r) => r.itemId === record.parentId);
  const parentKind =
    record.kind === 'outcome' || record.kind === 'coordinator' || children.length > 0;
  const tabs: Tab[] = parentKind
    ? ['Overview', 'Chat', 'Work', 'Materials']
    : ['Overview', 'Chat', 'Materials'];
  const current = tabs.includes(tab) ? tab : 'Overview';
  function select(next: Tab) {
    setTab(next);
    const params = new URLSearchParams(location.search);
    if (params.has('view') || params.has('chooseChat')) {
      params.delete('view');
      params.delete('chooseChat');
      navigate(
        { pathname: location.pathname, search: params.toString() },
        { replace: true, state: location.state },
      );
    }
    try {
      sessionStorage.setItem(key, next);
    } catch {
      setError('View preference could not be saved on this device.');
    }
  }
  const originalSources = record.sources.map((s) => ({
    type: s.type,
    url: s.url,
    title: s.title,
    author: s.author ?? '',
    snippet: s.rawSnippet,
  }));
  const artifactLinks = record.links.filter((l) => l.type === 'artifact');
  const links = record.links.filter((l) => l.type !== 'artifact');
  const sourceReturnParams = new URLSearchParams(location.search);
  sourceReturnParams.set('view', current);
  const sources = (
    <TelosItemSources
      itemId={record.itemId}
      legacySources={originalSources}
      onOpenExternal={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
      returnPath={`${location.pathname}?${sourceReturnParams}`}
    />
  );
  const materials = (
    <>
      <WorkOutputs itemId={record.itemId} profile={record.profile} ownsSavedArtifactRoute={false} />
      {artifactLinks.length > 0 && (
        <section className="todo-detail-contract">
          <h2>Saved document references</h2>
          {artifactLinks.map((link) => (
            <Link
              className="todo-detail-source-row"
              key={link.url}
              to={artifactViewerUrl(link.url, `/todos/${encodeURIComponent(record.itemId)}`)}
              state={location.state}
            >
              {link.title} · {link.description} · Added {date(link.addedAt)}
            </Link>
          ))}
        </section>
      )}
      {sources}
      <section className="todo-detail-contract">
        <h2>Links</h2>
        {links.length === 0 ? (
          <p>No external links.</p>
        ) : (
          links.map((link) => (
            <div key={link.type + link.url}>
              {/^(https?:|codex:)/.test(link.url) ? (
                <a
                  className="todo-detail-source-row"
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {link.title}
                </a>
              ) : (
                <p>
                  {link.title} · {link.url}
                </p>
              )}
              <small>
                {link.type} · {link.description} · Added {date(link.addedAt)}
              </small>
            </div>
          ))
        )}
      </section>
    </>
  );
  const work = (
    <section>
      <h2>{record.kind === 'coordinator' ? 'Coordinated outcomes' : 'Child work'}</h2>
      {relatedState === 'loading' && <p role="status">Loading child work…</p>}
      {relatedState === 'unavailable' && (
        <div role="alert">
          <p>Child work unavailable. Refresh to check its current state.</p>
          {onRefresh && (
            <button className="todo-detail-chat-btn" onClick={onRefresh}>
              Try again
            </button>
          )}
        </div>
      )}
      {children.length > 0 ? (
        <TelosOutcomesTree
          compact
          refreshKey={refreshKey}
          records={children}
          onOpen={onOpen}
          storageKey={'telos.child.navigation.' + record.itemId}
        />
      ) : relatedState === 'ready' ? (
        <p>No child work yet.</p>
      ) : null}
    </section>
  );
  return (
    <article className="telos-item-workspace">
      <header className="telos-item-heading">
        <button aria-label="Back" onClick={onBack}>
          <UiIcon name="back" size={20} />
        </button>
        <div className="telos-item-title">
          {parent && <button onClick={() => onOpen(parent.itemId)}>{parent.summary}</button>}
          <h1>{record.summary}</h1>
          <span className="telos-node-meta">
            {telosKindLabel(record.kind)} · {record.status}
          </span>
        </div>
        <TodoPrioritySelect
          saveState={prioritySaveState}
          priority={todoPriority(record)}
          onChange={(priority) => setTodoPriority(record.itemId, priority)}
        />
      </header>
      <nav className="telos-tabs" aria-label="Item views">
        {tabs.map((value) => (
          <button key={value} aria-pressed={value === current} onClick={() => select(value)}>
            {value}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      <div className="telos-dashboard">
        <div className="telos-workspace-content">
          {current === 'Chat' ? (
            <TelosItemChatTab
              key={record.itemId}
              itemId={record.itemId}
              title={record.summary}
              refreshKey={refreshKey}
            />
          ) : current === 'Materials' ? (
            materials
          ) : current === 'Work' ? (
            work
          ) : (
            <>
              <TelosItemRoleEntries key={record.itemId} itemId={record.itemId} />
              {parentKind ? (
                work
              ) : (
                <section>
                  <h2>{record.kind === 'work_item' ? 'This work item' : 'This item'}</h2>
                  <p>{record.intent || 'Not recorded'}</p>
                </section>
              )}
              <section className="telos-materials-section">
                <h2>Plans, documents & outputs</h2>
                {materials}
              </section>
            </>
          )}
        </div>
        <aside className="telos-brief" aria-label="Original brief">
          <h2>{record.kind === 'coordinator' ? 'Coordination mandate' : 'Outcome'}</h2>
          <p>{record.intent || 'Not recorded'}</p>
          <h2>Why this matters</h2>
          <p>{record.rationale || 'Not recorded'}</p>
          <h2>Done when</h2>
          {record.acceptanceCriteria.length > 0 ? (
            <ul>
              {record.acceptanceCriteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          ) : (
            <p>Not recorded</p>
          )}
          <h2>Task Hint</h2>
          <p>{record.contextHints.taskHint || 'Not recorded'}</p>
          <details className="telos-brief-context">
            <summary>Context</summary>
            <dl>
              {(
                [
                  ['Repositories', record.contextHints.repos],
                  ['Files', record.contextHints.paths],
                  ['Issues', record.contextHints.issues],
                  ['Documents', record.contextHints.docIds],
                  ['People', record.contextHints.people],
                  ['Jira issues', record.contextHints.jiraKeys],
                  ['Keywords', record.contextHints.keywords],
                  ['Session references', record.contextHints.sessionIds],
                ] as const
              )
                .filter(([, values]) => values.length > 0)
                .map(([label, values]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{values.join(' · ')}</dd>
                  </div>
                ))}
            </dl>
          </details>
          <h2>Origin & dates</h2>
          <dl>
            <dt>Profile</dt>
            <dd>{record.profile}</dd>
            <dt>Created</dt>
            <dd>{date(record.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{date(record.updatedAt)}</dd>
            {record.sources.map((source, i) => (
              <div key={i}>
                <dt>{source.title || source.type}</dt>
                <dd>
                  {source.author ?? 'Unknown'} · Created {date(source.createdAt)} · Added{' '}
                  {date(source.addedAt)} · Updated {date(source.updatedAt)}
                  <p>{source.rawSnippet}</p>
                </dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
      <SavedArtifactRouteDialog itemId={record.itemId} />
    </article>
  );
}
