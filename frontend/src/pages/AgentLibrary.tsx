import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  agentProfileLabel,
  type AgentLibraryCatalog,
  type AgentLibraryDraft,
  type AgentLibraryVersion,
  type SymposiumProfileDefinition,
  CompiledAgentContextSchema,
  type CompiledAgentContext,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { agentChatHref, agentLibraryTemplates, newAgentDefinition } from '../lib/agent-library';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { AgentProfileEditor } from '../components/AgentProfileEditor';
import { AgentCreationAdvisor } from '../components/AgentCreationAdvisor';
import { AgentContextPreview } from '../components/AgentContextPreview';
import { AgentTaskEditor } from '../components/AgentTaskEditor';
import { AgentTaskList } from '../components/AgentTaskList';
import { useAgentTasks } from '../hooks/useAgentTasks';
import {
  createAgentTaskWorkingCopy,
  editAgentTask,
  loadAgentTaskWorkingCopy,
} from '../lib/agent-task-working-copy';
import {
  loadAgentLibraryWorkingCopy,
  saveAgentLibraryWorkingCopy,
  type AgentLibraryEditor,
} from '../lib/agent-library-working-copy';
import '../styles/agent-library.css';

type Editor = AgentLibraryEditor;
type Tab = 'identity' | 'instructions' | 'context' | 'preview' | 'versions' | 'tasks';
async function read<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(
    path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result?.error || 'Agent Library request failed');
  return result as T;
}
const normalize = (definition: SymposiumProfileDefinition): SymposiumProfileDefinition => ({
  ...definition,
  name: definition.name.trim(),
  descriptor: definition.descriptor?.trim() || undefined,
  acceptanceCriteria: definition.acceptanceCriteria.map((s) => s.trim()).filter(Boolean),
  ...(definition.contextRecipe
    ? {
        contextRecipe:
          definition.contextRecipe.source === 'workspace'
            ? {
                ...definition.contextRecipe,
                files: definition.contextRecipe.files.map((file) => file.trim()).filter(Boolean),
                required: definition.contextRecipe.required
                  .filter((selector) => selector.some((part) => part.trim()))
                  .map((selector) => selector.map((part) => part.trim())),
                excluded: definition.contextRecipe.excluded
                  .filter((selector) => selector.some((part) => part.trim()))
                  .map((selector) => selector.map((part) => part.trim())),
              }
            : definition.contextRecipe.source === 'packs'
              ? definition.contextRecipe
              : {
                  ...definition.contextRecipe,
                  agentName: definition.contextRecipe.agentName.trim(),
                },
      }
    : {}),
  ...(definition.recipe
    ? {
        recipe: {
          ...definition.recipe,
          skillRefs: definition.recipe.skillRefs.map((s) => s.trim()).filter(Boolean),
          toolDefaults: {
            ...definition.recipe.toolDefaults,
            preferredTools: definition.recipe.toolDefaults.preferredTools
              .map((s) => s.trim())
              .filter(Boolean),
          },
        },
      }
    : {}),
});
function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : event.key === 'ArrowRight'
          ? (current + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (current + tabs.length - 1) % tabs.length
            : -1;
  if (next < 0) return;
  event.preventDefault();
  tabs[next].click();
  tabs[next].focus();
}
export function AgentLibrary() {
  const taskState = useAgentTasks();
  const [collection, setCollection] = useState<'profiles' | 'tasks'>(() =>
    loadAgentTaskWorkingCopy() ? 'tasks' : 'profiles',
  );
  const [recovered] = useState(loadAgentLibraryWorkingCopy);
  const [catalog, setCatalog] = useState<AgentLibraryCatalog | null>(null);
  const [editor, setEditor] = useState<Editor | null>(recovered?.editor ?? null);
  const [advisorOpen, setAdvisorOpen] = useState(
    !!recovered && !recovered.editor.publishedRevision,
  );
  const [tab, setTab] = useState<Tab>('identity');
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(!!recovered);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState('');
  const [compiledPreview, setCompiledPreview] = useState<CompiledAgentContext | null>(null);
  const [portable, setPortable] = useState('');
  const [importing, setImporting] = useState(false);
  const [importJson, setImportJson] = useState('');
  const saveKey = useRef(recovered?.saveKey ?? crypto.randomUUID());
  const publishKey = useRef(crypto.randomUUID());
  const importKey = useRef({ id: crypto.randomUUID(), key: crypto.randomUUID() });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty && !taskState.copy?.dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty, taskState.copy?.dirty]);
  const adopt = (version: AgentLibraryVersion | AgentLibraryDraft) => {
    if (!mounted.current) return;
    saveAgentLibraryWorkingCopy(null);
    setEditor({
      profileId: version.profileId,
      definition: structuredClone(version.definition),
      expectedVersion: 'version' in version ? version.version : 0,
      baseRevision: 'baseRevision' in version ? version.baseRevision : version.revision,
      publishedRevision: 'revision' in version ? version.revision : null,
    });
    setDirty(false);
    setError('');
    setPreview('');
    setCompiledPreview(null);
    setPortable('');
    saveKey.current = crypto.randomUUID();
    publishKey.current = crypto.randomUUID();
  };
  useEffect(() => {
    let live = true;
    read<AgentLibraryCatalog>('/api/agent-library')
      .then((rows) => {
        if (!live) return;
        if (!Array.isArray(rows.drafts) || !Array.isArray(rows.versions))
          throw Error('Agent Library response is invalid');
        setCatalog(rows);
        const first = rows.drafts[0] ?? rows.versions[0];
        if (first && !recovered) adopt(first);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : 'Library unavailable');
      });
    return () => {
      live = false;
    };
  }, [recovered]);
  const execute = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Library request failed');
    } finally {
      setBusy(false);
    }
  };
  const update = (definition: SymposiumProfileDefinition) => {
    if (!editor) return;
    const next = { ...editor, definition };
    saveKey.current = crypto.randomUUID();
    saveAgentLibraryWorkingCopy({ editor: next, saveKey: saveKey.current });
    setEditor(next);
    setDirty(true);
    setPreview('');
    setCompiledPreview(null);
    publishKey.current = crypto.randomUUID();
  };
  const save = () =>
    execute(async () => {
      if (!editor) return;
      const saved = await read<AgentLibraryDraft>('/api/agent-library/drafts', {
        profileId: editor.profileId,
        expectedVersion: editor.expectedVersion,
        expectedRevision: editor.baseRevision,
        idempotencyKey: saveKey.current,
        definition: normalize(editor.definition),
      });
      setCatalog(
        (current) =>
          current && {
            ...current,
            drafts: [saved, ...current.drafts.filter((d) => d.profileId !== saved.profileId)],
          },
      );
      adopt(saved);
      setNotice('Draft saved. Existing chats keep their published revision.');
    });
  const publish = () =>
    execute(async () => {
      if (!editor || dirty) return;
      const version = await read<AgentLibraryVersion>('/api/agent-library/publish', {
        profileId: editor.profileId,
        expectedVersion: editor.expectedVersion,
        idempotencyKey: publishKey.current,
      });
      setCatalog(
        (current) =>
          current && {
            drafts: current.drafts.filter((d) => d.profileId !== version.profileId),
            versions: [
              version,
              ...current.versions.filter(
                (v) => !(v.profileId === version.profileId && v.revision === version.revision),
              ),
            ],
          },
      );
      adopt(version);
      setNotice(`Published revision ${version.revision}. Ready to use in new chats and Symposium.`);
    });
  const create = () => {
    setCollection('profiles');
    const next = {
      profileId: crypto.randomUUID(),
      definition: newAgentDefinition(),
      expectedVersion: 0,
      baseRevision: 0,
      publishedRevision: null,
    };
    saveKey.current = crypto.randomUUID();
    saveAgentLibraryWorkingCopy({ editor: next, saveKey: saveKey.current });
    setEditor(next);
    setDirty(true);
    setTab('identity');
    setAdvisorOpen(true);
    setError('');
    setPreview('');
    setCompiledPreview(null);
    setPortable('');
  };
  const latest = new Map<string, AgentLibraryVersion>();
  for (const version of catalog?.versions ?? [])
    if (
      !latest.has(version.profileId) ||
      latest.get(version.profileId)!.revision < version.revision
    )
      latest.set(version.profileId, version);
  const entries = new Map<string, AgentLibraryDraft | AgentLibraryVersion>(latest);
  for (const draft of catalog?.drafts ?? []) entries.set(draft.profileId, draft);
  const visible = [...entries.values()].filter((entry) =>
    `${agentProfileLabel(entry.definition)} ${entry.definition.description ?? ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const historical =
    !dirty &&
    !!editor?.publishedRevision &&
    (latest.get(editor.profileId)?.revision ?? 0) > editor.publishedRevision;
  const selectedVersion = catalog?.versions.find(
    (v) => v.profileId === editor?.profileId && v.revision === editor?.publishedRevision,
  );
  const canUse = !!selectedVersion && !dirty;
  const openTask = (task: Parameters<typeof editAgentTask>[0]) => {
    taskState.update(editAgentTask(task));
    setCollection('tasks');
  };
  const assign = () => {
    if (!selectedVersion) return;
    taskState.update(createAgentTaskWorkingCopy(selectedVersion));
    setCollection('tasks');
  };
  const valid =
    !!editor?.definition.name.trim() &&
    !!editor.definition.descriptor?.trim() &&
    !!editor.definition.instructions.trim() &&
    !!editor.definition.expectedOutput.trim() &&
    editor.definition.acceptanceCriteria.some((s) => s.trim());
  return (
    <main className="workspace-page agent-library-page">
      <WorkspacePageHeading
        title="Agent Library"
        description="Give an agent a job. Use it wherever you work."
        actions={
          <>
            <button
              type="button"
              disabled={!catalog || busy}
              onClick={() => {
                setCollection('profiles');
                if (!editor) create();
                setAdvisorOpen(true);
              }}
            >
              Create with advisor
            </button>
            <button className="btn-primary" disabled={busy || dirty || !catalog} onClick={create}>
              New agent
            </button>
          </>
        }
      />
      <div
        className="agent-library-tabs"
        role="tablist"
        onKeyDown={navigateTabs}
        aria-label="Library collections"
      >
        {(['profiles', 'tasks'] as const).map((view) => (
          <button
            type="button"
            role="tab"
            tabIndex={collection === view ? 0 : -1}
            id={`library-${view}`}
            aria-selected={collection === view}
            aria-controls={`library-panel-${view}`}
            key={view}
            onClick={() => setCollection(view)}
          >
            {view === 'profiles' ? 'Profiles' : 'Tasks & schedules'}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id="library-panel-tasks"
        aria-labelledby="library-tasks"
        hidden={collection !== 'tasks'}
      >
        <div className="agent-library-toolbar">
          <h2>Tasks &amp; schedules</h2>
          <button
            type="button"
            disabled={taskState.loading || taskState.busy}
            onClick={() => void taskState.refresh()}
          >
            Refresh tasks
          </button>
        </div>
        {taskState.error && <p role="alert">{taskState.error}</p>}
        {taskState.storageError && <p role="alert">{taskState.storageError}</p>}
        {taskState.notice && <p role="status">{taskState.notice}</p>}
        {taskState.loading && <p role="status">Loading tasks…</p>}
        {taskState.copy && (
          <AgentTaskEditor
            copy={taskState.copy}
            versions={catalog?.versions ?? []}
            update={taskState.update}
            save={() => void taskState.save()}
            busy={taskState.busy}
          />
        )}
        {taskState.copy && (
          <button
            type="button"
            disabled={taskState.busy}
            onClick={() => {
              if (!taskState.copy?.dirty || window.confirm('Discard unsaved task input?'))
                taskState.update(null);
            }}
          >
            Close task editor
          </button>
        )}
        {taskState.tasks && (
          <AgentTaskList
            tasks={taskState.tasks}
            versions={catalog?.versions ?? []}
            onEdit={openTask}
            disabled={taskState.busy || !!taskState.copy?.dirty}
          />
        )}
      </section>
      <section
        role="tabpanel"
        id="library-panel-profiles"
        aria-labelledby="library-profiles"
        hidden={collection !== 'profiles'}
      >
        <div className="agent-library-toolbar">
          <input
            aria-label="Search agents"
            placeholder="Search names and descriptors…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button disabled={busy || dirty || !catalog} onClick={() => setImporting(!importing)}>
            Import profile
          </button>
          <Link to="/tasks" className="workspace-text-link">
            Agent taskboard
          </Link>
        </div>
        {error && (
          <p role="alert" className="agent-library-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {!catalog && !error && <p role="status">Loading Agent Library…</p>}
        {importing && (
          <section className="agent-library-import" aria-label="Import a profile">
            <label>
              Portable profile JSON
              <textarea
                rows={6}
                value={importJson}
                onChange={(e) => {
                  setImportJson(e.target.value);
                  importKey.current = { id: crypto.randomUUID(), key: crypto.randomUUID() };
                }}
              />
            </label>
            <button
              disabled={busy || !importJson.trim()}
              onClick={() =>
                void execute(async () => {
                  const artifact: unknown = JSON.parse(importJson);
                  const saved = await read<AgentLibraryDraft>('/api/agent-library/import', {
                    profileId: importKey.current.id,
                    artifact,
                    idempotencyKey: importKey.current.key,
                  });
                  setCatalog(
                    (current) => current && { ...current, drafts: [saved, ...current.drafts] },
                  );
                  adopt(saved);
                  setTab('identity');
                  setImporting(false);
                  setNotice('Imported as a new draft. Review and publish it to use.');
                })
              }
            >
              Import as draft
            </button>
          </section>
        )}
        {catalog && (
          <div className="agent-library-layout">
            <section className="agent-library-directory" aria-label="Saved agents">
              {visible.map((entry) => (
                <button
                  key={entry.profileId}
                  className={`agent-library-entry${editor?.profileId === entry.profileId ? ' selected' : ''}`}
                  aria-pressed={editor?.profileId === entry.profileId}
                  disabled={busy || dirty}
                  onClick={() => {
                    adopt(entry);
                    setTab('identity');
                  }}
                >
                  <strong>{entry.definition.name}</strong>
                  <span className="agent-library-descriptor">
                    {entry.definition.descriptor ?? entry.definition.role}
                  </span>
                  <span>{entry.definition.description}</span>
                  <small>
                    {'version' in entry
                      ? `Draft · saved ${entry.version}`
                      : `Published · r${entry.revision}`}
                  </small>
                </button>
              ))}
              {!visible.length && (
                <p>
                  {query
                    ? 'No matching agents.'
                    : 'Create your first agent, or start with the advisor.'}
                </p>
              )}
            </section>
            <div className="agent-library-workbench">
              {editor && (
                <AgentCreationAdvisor
                  key={editor.profileId}
                  definition={editor.definition}
                  onApply={(definition) => {
                    update(definition);
                    setTab('identity');
                  }}
                  open={advisorOpen}
                  onOpenChange={setAdvisorOpen}
                  disabled={busy || historical}
                />
              )}
              <section className="agent-library-detail" aria-label="Agent profile editor">
                {editor ? (
                  <>
                    <div className="agent-library-heading">
                      <div>
                        <h2>{editor.definition.name || 'New agent'}</h2>
                        <p className="agent-library-descriptor">
                          {editor.definition.descriptor || 'Choose a descriptor'}
                        </p>
                      </div>
                      <span>
                        {dirty
                          ? 'Unsaved edits'
                          : editor.publishedRevision
                            ? `Published · r${editor.publishedRevision}`
                            : `Draft · saved ${editor.expectedVersion}`}
                      </span>
                    </div>
                    {canUse && (
                      <div className="agent-library-actions">
                        {' '}
                        <Link
                          className="btn-primary"
                          to={agentChatHref(editor.profileId, editor.publishedRevision!)}
                        >
                          Use in session
                        </Link>
                        <button
                          type="button"
                          disabled={taskState.busy || !!taskState.copy?.dirty}
                          onClick={assign}
                        >
                          Assign task
                        </button>
                      </div>
                    )}
                    <div
                      className="agent-library-tabs"
                      role="tablist"
                      onKeyDown={navigateTabs}
                      aria-label="Profile sections"
                    >
                      {(
                        [
                          'identity',
                          'instructions',
                          'context',
                          'preview',
                          'tasks',
                          'versions',
                        ] as const
                      ).map((item) => (
                        <button
                          key={item}
                          id={`agent-library-tab-${item}`}
                          role="tab"
                          tabIndex={tab === item ? 0 : -1}
                          aria-selected={tab === item}
                          aria-controls="agent-library-panel"
                          onClick={() => setTab(item)}
                        >
                          {item === 'tasks'
                            ? 'Assigned tasks'
                            : item === 'preview'
                              ? 'Prompt preview'
                              : item[0].toUpperCase() + item.slice(1)}
                        </button>
                      ))}
                    </div>
                    <div
                      id="agent-library-panel"
                      role="tabpanel"
                      aria-labelledby={`agent-library-tab-${tab}`}
                    >
                      {(['identity', 'instructions', 'context'] as string[]).includes(tab) && (
                        <AgentProfileEditor
                          value={editor.definition}
                          onChange={update}
                          tab={tab as 'identity' | 'instructions' | 'context'}
                          disabled={busy || historical}
                        />
                      )}
                      {tab === 'preview' && (
                        <>
                          <p>
                            Preview the profile instructions and selected context. Mitzo adds its
                            platform instructions when the chat starts.
                          </p>
                          <button
                            disabled={busy || !valid}
                            onClick={() =>
                              void execute(async () => {
                                setPreview('');
                                setCompiledPreview(null);
                                const result = await read<{
                                  profilePrompt: string;
                                  assembledPrompt?: string;
                                  compiledContext?: CompiledAgentContext;
                                }>('/api/agent-library/preview', {
                                  definition: normalize(editor.definition),
                                });
                                const compiled = result.compiledContext
                                  ? CompiledAgentContextSchema.parse(result.compiledContext)
                                  : null;
                                setCompiledPreview(compiled);
                                setPreview(result.assembledPrompt ?? result.profilePrompt);
                              })
                            }
                          >
                            {editor.definition.contextRecipe
                              ? 'Compile preview'
                              : 'Preview guidance'}
                          </button>
                          {compiledPreview && <AgentContextPreview value={compiledPreview} />}
                          {preview && <pre className="agent-library-prompt">{preview}</pre>}
                        </>
                      )}
                      {tab === 'tasks' && (
                        <>
                          {taskState.error && <p role="alert">{taskState.error}</p>}
                          {taskState.tasks && (
                            <AgentTaskList
                              tasks={taskState.tasks.filter(
                                (t) => t.definition.profile.profileId === editor.profileId,
                              )}
                              versions={catalog.versions}
                              onEdit={openTask}
                              disabled={taskState.busy || !!taskState.copy?.dirty}
                            />
                          )}
                        </>
                      )}
                      {tab === 'versions' && (
                        <>
                          <p>
                            Published revisions are immutable. Existing conversations keep their
                            selected revision.
                          </p>
                          {catalog.versions
                            .filter((v) => v.profileId === editor.profileId)
                            .map((v) => (
                              <button
                                disabled={busy || dirty}
                                key={v.revision}
                                onClick={() => adopt(v)}
                              >
                                {agentProfileLabel(v.definition)} · r{v.revision}
                              </button>
                            ))}
                        </>
                      )}
                    </div>
                    {!historical && (
                      <div className="agent-library-actions">
                        <button
                          disabled={busy || !valid || (!dirty && editor.expectedVersion > 0)}
                          onClick={() => void save()}
                        >
                          Save draft
                        </button>
                        {!editor.publishedRevision && editor.expectedVersion > 0 && (
                          <button
                            className="btn-primary"
                            disabled={busy || dirty}
                            onClick={() => void publish()}
                          >
                            Publish revision
                          </button>
                        )}
                        {dirty && (
                          <button
                            disabled={busy}
                            onClick={() => {
                              const saved = entries.get(editor.profileId);
                              if (saved) adopt(saved);
                              else {
                                saveAgentLibraryWorkingCopy(null);
                                setEditor(null);
                                setDirty(false);
                              }
                            }}
                          >
                            Discard unsaved edits
                          </button>
                        )}
                        {editor.baseRevision === 0 && editor.expectedVersion === 0 && (
                          <label>
                            Start from a template
                            <select
                              value=""
                              onChange={(e) => {
                                const template = agentLibraryTemplates.find(
                                  (t) => t.id === e.target.value,
                                );
                                if (template)
                                  update({
                                    ...structuredClone(template.definition),
                                    name: editor.definition.name,
                                    descriptor: template.definition.descriptor,
                                  });
                              }}
                            >
                              <option value="">Choose a template</option>
                              {agentLibraryTemplates.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.definition.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                      </div>
                    )}
                    {canUse && (
                      <div className="agent-library-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void execute(async () => {
                              const version = await read<AgentLibraryVersion>(
                                `/api/agent-library/${encodeURIComponent(editor.profileId)}/${editor.publishedRevision}/export`,
                              );
                              setPortable(JSON.stringify(version, null, 2));
                            })
                          }
                        >
                          Export profile
                        </button>
                      </div>
                    )}
                    {portable && (
                      <label>
                        Portable profile export
                        <textarea readOnly rows={7} value={portable} />
                      </label>
                    )}
                  </>
                ) : (
                  <p>Select a saved agent or create one to get started.</p>
                )}
              </section>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
