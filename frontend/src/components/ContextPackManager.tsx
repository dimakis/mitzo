import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ContextPackDefinitionSchema } from '@mitzo/protocol';
import type {
  CompiledAgentContext,
  ContextPackDefinition,
  ContextPackDraft,
  PublishedContextPack,
} from '@mitzo/protocol';
import type { KnowledgeCatalog } from '../types/knowledge';
import { apiFetch } from '../lib/api-fetch';
import { AgentContextPreview } from './AgentContextPreview';
import { MotionPresence } from './MotionPresence';
import '../styles/agent-library.css';

type Catalog = { packs: PublishedContextPack[]; drafts: ContextPackDraft[] };
type Copy = {
  definition: ContextPackDefinition;
  draft?: ContextPackDraft;
  base?: PublishedContextPack;
  dirty: boolean;
  requestId?: string;
};
const storageKey = 'mitzo-context-pack-working-copy';
let memoryCopy: Copy | null = null;
let pendingStorage = false;
function recover(): Copy | null {
  if (pendingStorage) return memoryCopy;
  try {
    return JSON.parse(sessionStorage.getItem(storageKey) || 'null');
  } catch {
    return null;
  }
}
async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await apiFetch(
    path,
    body === undefined
      ? undefined
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Context request failed');
  return result;
}
const advisor =
  'Help me draft a reusable context pack. Ask about the agent job, desired output, source choices and token budget. Use verified accepted Knowledge document references and exact accepted Git revisions, never invented paths or source revisions. Explain required, prioritized and excluded heading choices, retrieval guidance and rationale. Return portable JSON {"definition":{"version":1,"id":"chosen-slug","name":"Chosen name","description":"Purpose","tokenBudget":4000,"documents":[{"path":"verified.md","revision":"verified accepted Git SHA","mode":"prioritized","headings":[],"priority":50}],"retrievalGuidance":"When and how to retrieve more","rationale":"Why these choices"}} for manual import in Knowledge Context. This is a draft for explicit user save and publication; do not publish or grant access.';
export function ContextPackManager({ knowledge }: { knowledge: KnowledgeCatalog | null }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [copy, setCopy] = useState<Copy | null>(recover);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const [preview, setPreview] = useState<CompiledAgentContext>();
  const [revisions, setRevisions] = useState<PublishedContextPack[]>([]);
  const [historyError, setHistoryError] = useState('');
  const selectionRequest = useRef(0);
  const [profiles, setProfiles] = useState<
    { name: string; profileId: string; revision: number; packRevision?: number }[]
  >([]);
  const [document, setDocument] = useState('');
  const [importing, setImporting] = useState(false);
  const [json, setJson] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = async () => {
    const value = await request<Catalog>('/api/context-packs');
    if (!Array.isArray(value.packs) || !Array.isArray(value.drafts))
      throw Error('Context catalog unavailable');
    if (mounted.current) setCatalog(value);
  };
  useEffect(() => {
    void refresh().catch((cause) => setError(cause.message));
  }, []);
  useEffect(() => {
    memoryCopy = copy?.dirty ? copy : null;
    try {
      if (copy?.dirty) sessionStorage.setItem(storageKey, JSON.stringify(copy));
      else sessionStorage.removeItem(storageKey);
      pendingStorage = false;
    } catch {
      pendingStorage = true;
      if (copy?.dirty)
        setError(
          'Browser recovery storage is unavailable. Keep this page open until your draft is saved.',
        );
    }
    if (!copy?.dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [copy]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Context request failed');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const update = (definition: ContextPackDefinition) => {
    setCopy((current) =>
      current ? { ...current, definition, dirty: true, requestId: crypto.randomUUID() } : null,
    );
    setPreview(undefined);
    setNotice('');
  };
  const open = (value: PublishedContextPack | ContextPackDraft) => {
    if (copy?.dirty) {
      setError('Save or discard your working copy before opening another pack.');
      return;
    }
    setCopy({
      definition: structuredClone(value.definition),
      ...('revision' in value ? { base: value } : { draft: value }),
      dirty: false,
    });
    setPreview(undefined);
    setProfiles([]);
    setRevisions([]);
    setHistoryError('');
    const selectedRequest = ++selectionRequest.current;
    void request<{ revisions: PublishedContextPack[] }>(
      `/api/context-packs/${encodeURIComponent(value.definition.id)}/revisions`,
    )
      .then((result) => {
        if (mounted.current && selectedRequest === selectionRequest.current)
          setRevisions(Array.isArray(result.revisions) ? result.revisions : []);
      })
      .catch(() => {
        if (mounted.current && selectedRequest === selectionRequest.current)
          setHistoryError('Revision history unavailable.');
      });
    setError('');
    setNotice('');
    void request<{ profiles: typeof profiles }>(
      `/api/context-packs/${encodeURIComponent(value.definition.id)}/impact`,
    )
      .then((result) => {
        if (mounted.current && selectedRequest === selectionRequest.current)
          setProfiles(result.profiles);
      })
      .catch(() =>
        setNotice('Profile impact is unavailable. Published profiles keep their pinned revisions.'),
      );
  };
  const saved = !!copy?.draft && !copy.dirty && copy.draft.state === 'draft';
  return (
    <section className="agent-library-page context-pack-manager" aria-label="Context packs">
      <div className="agent-library-toolbar">
        <button
          disabled={busy || !!copy?.dirty}
          onClick={() => {
            setCopy({
              definition: {
                version: 1,
                id: crypto.randomUUID(),
                name: '',
                description: '',
                tokenBudget: 4000,
                documents: [],
                retrievalGuidance: '',
              },
              dirty: true,
              requestId: crypto.randomUUID(),
            });
            setPreview(undefined);
            setProfiles([]);
          }}
        >
          New pack
        </button>
        <Link className="workspace-text-link" to={`/chat?prompt=${encodeURIComponent(advisor)}`}>
          Create context with advisor
        </Link>
        <button disabled={busy} onClick={() => setImporting((value) => !value)}>
          Import pack JSON
        </button>
      </div>
      <p>
        Reusable source choices for agents. Profiles pin published revisions; publishing a pack
        leaves their current pins in place.
      </p>
      {error && (
        <p role="alert" className="agent-library-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!catalog && !error && <p role="status">Loading context packs…</p>}
      <MotionPresence open={importing} kind="disclosure">
        <div className="agent-library-import">
          <label>
            Portable context pack JSON
            <textarea rows={6} value={json} onChange={(event) => setJson(event.target.value)} />
          </label>
          <button
            disabled={busy || !!copy?.dirty}
            onClick={() => {
              try {
                const value = JSON.parse(json);
                const definition = ContextPackDefinitionSchema.parse(value.definition ?? value);
                setCopy({ definition, dirty: true, requestId: crypto.randomUUID() });
                setImporting(false);
                setNotice('Imported working copy. Review source choices before saving.');
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Invalid JSON');
              }
            }}
          >
            Review imported pack
          </button>
        </div>
      </MotionPresence>
      <div className="agent-library-layout">
        <div className="agent-library-directory" aria-label="Saved context packs">
          {catalog?.drafts
            .filter((draft) => draft.state === 'draft')
            .map((draft) => (
              <button
                className="agent-library-entry"
                key={draft.id}
                disabled={busy}
                onClick={() => open(draft)}
              >
                <strong>{draft.definition.name}</strong>
                <span>Draft {draft.version}</span>
              </button>
            ))}
          {catalog?.packs.map((pack) => (
            <button
              className="agent-library-entry"
              key={`${pack.definition.id}:${pack.revision}`}
              disabled={busy}
              onClick={() => open(pack)}
            >
              <strong>{pack.definition.name}</strong>
              <span>Revision {pack.revision}</span>
            </button>
          ))}
          {catalog && !catalog.packs.length && !catalog.drafts.length && (
            <p>Create your first context pack, or start with the advisor.</p>
          )}
        </div>
        <div className="agent-library-detail">
          {copy ? (
            <>
              <fieldset className="agent-library-fields" disabled={busy}>
                <label>
                  Pack name
                  <input
                    value={copy.definition.name}
                    maxLength={80}
                    onChange={(event) => update({ ...copy.definition, name: event.target.value })}
                  />
                </label>
                <label>
                  Pack identifier
                  <input
                    value={copy.definition.id}
                    disabled={!!copy.base || !!copy.draft}
                    onChange={(event) => update({ ...copy.definition, id: event.target.value })}
                  />
                </label>
                <label>
                  Pack description
                  <textarea
                    rows={2}
                    value={copy.definition.description}
                    onChange={(event) =>
                      update({ ...copy.definition, description: event.target.value })
                    }
                  />
                </label>
                <label>
                  Pack token budget
                  <input
                    type="number"
                    min={256}
                    max={32000}
                    value={copy.definition.tokenBudget || ''}
                    onChange={(event) =>
                      update({ ...copy.definition, tokenBudget: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Accepted document
                  <select
                    value={document || knowledge?.documents[0]?.path || ''}
                    onChange={(event) => setDocument(event.target.value)}
                  >
                    {knowledge?.documents.map((item) => (
                      <option key={item.path} value={item.path}>
                        {item.title} · {item.path}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={!knowledge?.documents.length}
                  onClick={() => {
                    const path = document || knowledge!.documents[0].path;
                    update({
                      ...copy.definition,
                      documents: [
                        ...copy.definition.documents,
                        {
                          path,
                          revision: knowledge!.revision,
                          mode: 'prioritized',
                          headings: [],
                          priority: 50,
                        },
                      ],
                    });
                  }}
                >
                  Add accepted document
                </button>
                {copy.definition.documents.map((source, index) => {
                  const change = (patch: Partial<typeof source>) =>
                    update({
                      ...copy.definition,
                      documents: copy.definition.documents.map((item, i) =>
                        i === index ? { ...item, ...patch } : item,
                      ),
                    });
                  return (
                    <fieldset className="agent-library-context-recipe" key={index}>
                      <legend>{source.path}</legend>
                      <p>
                        Accepted revision: <code>{source.revision}</code>
                      </p>
                      <label>
                        Selection for {source.path}
                        <select
                          value={source.mode}
                          onChange={(event) =>
                            change({ mode: event.target.value as typeof source.mode })
                          }
                        >
                          <option value="required">Required</option>
                          <option value="prioritized">Prioritized</option>
                          <option value="excluded">Excluded</option>
                        </select>
                      </label>
                      <label>
                        Heading paths for {source.path}
                        <textarea
                          rows={3}
                          placeholder="Design > Decisions"
                          value={source.headings.map((parts) => parts.join(' > ')).join('\n')}
                          onChange={(event) =>
                            change({
                              headings: event.target.value
                                .split('\n')
                                .map((line) => line.split(' > ')),
                            })
                          }
                        />
                      </label>
                      <p>One heading path per line. Leave blank to select the whole document.</p>
                      <label>
                        Priority for {source.path}
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={source.priority}
                          onChange={(event) => change({ priority: Number(event.target.value) })}
                        />
                      </label>
                      <button
                        onClick={() =>
                          update({
                            ...copy.definition,
                            documents: copy.definition.documents.filter((_, i) => i !== index),
                          })
                        }
                      >
                        Remove {source.path}
                      </button>
                    </fieldset>
                  );
                })}
                <label>
                  Retrieval guidance
                  <textarea
                    rows={3}
                    value={copy.definition.retrievalGuidance}
                    onChange={(event) =>
                      update({ ...copy.definition, retrievalGuidance: event.target.value })
                    }
                  />
                </label>
                <label>
                  Source choice rationale
                  <textarea
                    rows={3}
                    value={copy.definition.rationale || ''}
                    onChange={(event) =>
                      update({ ...copy.definition, rationale: event.target.value })
                    }
                  />
                </label>
              </fieldset>
              <div className="agent-library-actions">
                <button
                  disabled={busy || !copy.dirty}
                  onClick={() =>
                    void run(async () => {
                      const definition = {
                        ...copy.definition,
                        documents: copy.definition.documents.map((source) => ({
                          ...source,
                          headings: source.headings
                            .filter((parts) => parts.some((part) => part.trim()))
                            .map((parts) => parts.map((part) => part.trim())),
                        })),
                      };
                      const result = await request<{ draft: ContextPackDraft }>(
                        copy.draft
                          ? `/api/context-packs/drafts/${copy.draft.id}`
                          : '/api/context-packs/drafts',
                        copy.draft
                          ? { version: copy.draft.version, definition, requestId: copy.requestId }
                          : { definition, requestId: copy.requestId },
                        copy.draft ? 'PUT' : 'POST',
                      );
                      if (mounted.current) {
                        setCopy({
                          ...copy,
                          definition: result.draft.definition,
                          draft: result.draft,
                          dirty: false,
                        });
                        setNotice('Draft saved');
                        await refresh();
                      }
                    })
                  }
                >
                  Save pack draft
                </button>
                <button
                  disabled={busy || !saved}
                  onClick={() =>
                    void run(async () => {
                      const result = await request<{ issues: string[] }>(
                        `/api/context-packs/drafts/${copy.draft!.id}/validate`,
                        { version: copy.draft!.version },
                      );
                      setNotice(
                        result.issues.length
                          ? result.issues.join('\n')
                          : 'Source validation passed. No model review was performed.',
                      );
                    })
                  }
                >
                  Validate sources
                </button>
                <button
                  disabled={busy || !saved}
                  onClick={() =>
                    void run(async () => {
                      setPreview(undefined);
                      const result = await request<{ compiledContext: CompiledAgentContext }>(
                        `/api/context-packs/drafts/${copy.draft!.id}/preview`,
                        { version: copy.draft!.version },
                      );
                      setPreview(result.compiledContext);
                    })
                  }
                >
                  Compile pack preview
                </button>
                <button
                  disabled={busy || !saved}
                  onClick={() =>
                    void run(async () => {
                      const result = await request<{ pack: PublishedContextPack }>(
                        `/api/context-packs/drafts/${copy.draft!.id}/publish`,
                        { version: copy.draft!.version },
                      );
                      setCopy({
                        definition: result.pack.definition,
                        base: result.pack,
                        dirty: false,
                      });
                      setNotice(
                        `Published revision ${result.pack.revision}. Profiles retain their current pins.`,
                      );
                      await refresh();
                    })
                  }
                >
                  Publish pack revision
                </button>
                <button
                  disabled={busy || !copy.dirty}
                  onClick={() => {
                    setCopy(
                      copy.draft
                        ? {
                            ...copy,
                            definition: structuredClone(copy.draft.definition),
                            dirty: false,
                          }
                        : copy.base
                          ? {
                              ...copy,
                              definition: structuredClone(copy.base.definition),
                              dirty: false,
                            }
                          : null,
                    );
                    setPreview(undefined);
                  }}
                >
                  Discard pack edits
                </button>
              </div>
              <button aria-expanded={details} onClick={() => setDetails((value) => !value)}>
                Revision comparison and affected profiles
              </button>
              <MotionPresence open={details} kind="disclosure">
                <div className="agent-library-context-preview">
                  <h3>Published revisions</h3>
                  {historyError && <p>{historyError}</p>}
                  <div className="agent-library-actions">
                    {revisions.map((revision) => (
                      <button
                        disabled={busy || copy.dirty}
                        key={revision.revision}
                        onClick={() => open(revision)}
                      >
                        View pack revision {revision.revision}
                      </button>
                    ))}
                  </div>
                  {copy.base && (
                    <p>
                      Viewing immutable revision {copy.base.revision}. Editing creates a new draft
                      against the latest published revision.
                    </p>
                  )}
                  <h3>Affected profiles</h3>
                  {profiles.length ? (
                    <ul>
                      {profiles.map((profile) => (
                        <li key={`${profile.profileId}:${profile.revision}`}>
                          {profile.name} · profile revision {profile.revision}
                          {profile.packRevision ? ` · pack revision ${profile.packRevision}` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      No profile references reported. Published profiles retain their pinned
                      revision.
                    </p>
                  )}
                  <h3>Saved source choices</h3>
                  <pre className="agent-library-prompt">
                    {JSON.stringify(
                      copy.base?.definition || copy.draft?.definition || null,
                      null,
                      2,
                    )}
                  </pre>
                  <h3>Your working source choices</h3>
                  <pre className="agent-library-prompt">
                    {JSON.stringify(copy.definition, null, 2)}
                  </pre>
                </div>
              </MotionPresence>
              {preview && (
                <>
                  <AgentContextPreview value={preview} />
                  <pre className="agent-library-prompt">{preview.context.fullMarkdown}</pre>
                </>
              )}
            </>
          ) : (
            <p>Choose a pack to review its sources and revisions.</p>
          )}
        </div>
      </div>
    </section>
  );
}
