import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AgentToolCatalogEntry } from '@mitzo/protocol';
import { MotionPresence } from './MotionPresence';
import {
  toolBuilderRequest as request,
  type ToolDraftRecord,
  type ToolDraftSummary,
} from '../lib/tool-builder-api';

export function ToolBuilderReview({
  tools,
  onPublished,
}: {
  tools: AgentToolCatalogEntry[];
  onPublished(): void;
}) {
  const [params] = useSearchParams();
  const initialId = params.get('toolDraft');
  const initialVersion = params.get('draftVersion');
  const [open, setOpen] = useState(!!initialId);
  const [inventory, setInventory] = useState<ToolDraftSummary[]>();
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [record, setRecord] = useState<ToolDraftRecord>();
  const [feedback, setFeedback] = useState('');
  const [file, setFile] = useState('');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [publishedHere, setPublishedHere] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbortController | null>(null);
  const run = useCallback(
    async (label: string, operation: (signal: AbortSignal) => Promise<void>) => {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setBusy(label);
      setError('');
      setNotice('');
      try {
        await operation(controller.signal);
      } catch (e) {
        if (pending.current === controller)
          setError(
            controller.signal.aborted
              ? 'Request cancelled. Reload to confirm the saved state.'
              : e instanceof Error
                ? e.message
                : 'Tool draft request failed',
          );
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          setBusy('');
        }
      }
    },
    [],
  );
  useEffect(() => () => pending.current?.abort(), []);
  const select = useCallback((value: ToolDraftRecord, id: string, version: number) => {
    if (!value?.draft?.id || !Array.isArray(value.draft.files) || !value.draft.tests)
      throw Error('Tool draft response is invalid');
    if (value.draft.id !== id || value.draft.version !== version)
      throw Error('Requested tool draft version changed. Reload before reviewing.');
    setRecord(value);
    setInventory((current) =>
      current?.map((item) =>
        item.id === id && item.version === version ? { ...item, status: value.status } : item,
      ),
    );
    setFeedback(value.review?.feedback ?? '');
    setFile(value.draft.files[0]?.path ?? '');
    setOffset(0);
  }, []);
  const load = useCallback(
    (id?: string, version?: number) =>
      run('Loading tool drafts…', async (signal) => {
        const result = await request<{ drafts: ToolDraftSummary[]; nextOffset: number | null }>(
          '',
          signal,
        );
        if (!Array.isArray(result.drafts)) throw Error('Tool draft inventory is invalid');
        setInventory(result.drafts);
        setNextOffset(result.nextOffset);
        if (id && version)
          select(
            await request<ToolDraftRecord>(`/drafts/${encodeURIComponent(id)}/${version}`, signal),
            id,
            version,
          );
      }),
    [run, select],
  );
  useEffect(() => {
    if (initialId && initialVersion) {
      pending.current?.abort();
      pending.current = null;
      setOpen(true);
      const version = Number(initialVersion);
      if (!Number.isSafeInteger(version) || version < 1) {
        setError('Tool draft link is invalid. Choose a saved draft.');
        return;
      }
      void load(initialId, version);
    }
    return () => {
      pending.current?.abort();
    };
  }, [initialId, initialVersion, load]);
  const close = () => {
    pending.current?.abort();
    setOpen(false);
    opener.current?.focus();
  };
  const draft = record?.draft;
  const catalogEntry =
    draft &&
    tools.find((tool) => tool.id === `custom:${draft.id}` && tool.version === draft.version);
  const published =
    !!draft &&
    (publishedHere === `${draft.id}:${draft.version}` ||
      tools.some((tool) => tool.id === `custom:${draft.id}` && tool.version === draft.version));
  const source = draft?.files.find((value) => value.path === file)?.content ?? '';
  const act = (action: 'accepted' | 'rejected' | 'publish' | 'cancel') => {
    if (!draft) return;
    void run(
      action === 'publish' ? 'Qualifying installed implementation…' : 'Saving operator decision…',
      async (signal) => {
        const path = `/drafts/${encodeURIComponent(draft.id)}/${draft.version}`;
        if (action === 'publish') {
          const result = await request<{
            reference: { id: string; version: number; revision: string };
          }>(path + '/publish', signal, { contractDigest: draft.contractDigest });
          if (
            result.reference?.id !== `custom:${draft.id}` ||
            result.reference.version !== draft.version
          )
            throw Error('Publication receipt is invalid. Reload to confirm the saved state.');
          setPublishedHere(`${draft.id}:${draft.version}`);
          setNotice('Published. Assign the tool to an agent separately and start a new chat.');
          onPublished();
        } else {
          select(
            await request<ToolDraftRecord>(
              path + (action === 'cancel' ? '/cancel' : '/review'),
              signal,
              action === 'cancel'
                ? {}
                : { decision: action, feedback, contractDigest: draft.contractDigest },
            ),
            draft.id,
            draft.version,
          );
          setNotice(
            action === 'accepted'
              ? 'Review accepted. Publication still requires the exact reviewed implementation installed and qualified.'
              : action === 'rejected'
                ? 'Changes requested. Return to the Builder conversation to prepare a new version.'
                : 'Draft cancelled. The tool catalog is unchanged.',
          );
        }
      },
    );
  };
  function download() {
    if (!record) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ format: 'mitzo-tool-draft-review-v1', ...record }, null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `tool-draft-${record.draft.id}-v${record.draft.version}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section aria-label="Tool drafts">
      <div className="agent-library-actions">
        <button
          type="button"
          ref={opener}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            if (!open && !inventory) void load();
          }}
        >
          Review tool drafts
        </button>
      </div>
      <MotionPresence open={open} kind="disclosure">
        <section
          className="agent-library-fields"
          aria-label="Tool draft review"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
        >
          <h2>Tool drafts</h2>
          <p>
            Inspect the tested source bundle and give feedback. Acceptance and publication are
            separate. The Builder cannot approve its work.
          </p>
          {busy && <p role="status">{busy}</p>}
          {error && (
            <p role="alert" className="agent-library-error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <div className="agent-library-actions">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void load(draft?.id, draft?.version)}
            >
              Reload tool drafts
            </button>
            {busy && (
              <button type="button" onClick={() => pending.current?.abort()}>
                Cancel request
              </button>
            )}
            <button type="button" onClick={close}>
              Done reviewing
            </button>
          </div>
          {inventory?.length === 0 && <p>No tool drafts yet. Start with Build a tool.</p>}
          {!!inventory?.length && (
            <label>
              Saved tool draft
              <select
                disabled={!!busy}
                value={draft ? `${draft.id}:${draft.version}` : ''}
                onChange={(event) => {
                  const selected = inventory.find(
                    (item) => `${item.id}:${item.version}` === event.target.value,
                  );
                  if (selected)
                    void run('Loading draft…', async (signal) =>
                      select(
                        await request<ToolDraftRecord>(
                          `/drafts/${selected.id}/${selected.version}`,
                          signal,
                        ),
                        selected.id,
                        selected.version,
                      ),
                    );
                }}
              >
                <option value="">Choose a draft</option>
                {draft &&
                  !inventory.some(
                    (item) => item.id === draft.id && item.version === draft.version,
                  ) && (
                    <option value={`${draft.id}:${draft.version}`}>
                      {draft.name} · v{draft.version}
                    </option>
                  )}
                {inventory.map((item) => (
                  <option key={`${item.id}:${item.version}`} value={`${item.id}:${item.version}`}>
                    {item.name} · v{item.version} · {item.status}
                  </option>
                ))}
              </select>
            </label>
          )}
          {nextOffset !== null && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() =>
                void run('Loading more drafts…', async (signal) => {
                  const next = await request<{
                    drafts: ToolDraftSummary[];
                    nextOffset: number | null;
                  }>(`?offset=${nextOffset}`, signal);
                  if (!Array.isArray(next.drafts)) throw Error('Tool draft inventory is invalid');
                  setInventory((current) => [...(current ?? []), ...next.drafts]);
                  setNextOffset(next.nextOffset);
                })
              }
            >
              More tool drafts
            </button>
          )}
          {record && draft && (
            <>
              <h3>
                {draft.name} · v{draft.version}
              </h3>
              <p>{draft.description}</p>
              <p>
                Status: {record.status}
                {published ? ' · Published' : ''}
              </p>
              {published && catalogEntry && !catalogEntry.routes.includes('local-api') && (
                <p role="status">
                  This published version is unavailable because installed source changed. Prepare
                  and review a new version, then publish and reselect in a new chat.
                </p>
              )}
              <Link to={`/chat/${encodeURIComponent(record.sessionId)}`}>Builder conversation</Link>
              <p>{draft.tests.summary}</p>
              <p>
                {published
                  ? 'Draft test report retained. Publication independently qualified the accepted installed implementation.'
                  : draft.tests.evidenceKind === 'candidate-report'
                    ? 'Candidate test report; independent installed-source qualification is still required.'
                    : 'Reported test results; publication independently qualifies the installed implementation.'}
              </p>
              <details>
                <summary>Contract and evidence</summary>
                <pre className="agent-library-prompt">
                  {JSON.stringify(
                    {
                      inputSchema: draft.inputSchema,
                      outputSchema: draft.outputSchema,
                      examples: draft.examples,
                      permissions: draft.permissions,
                      compatibility: draft.compatibility,
                      testProfile: draft.testProfile,
                      tests: draft.tests,
                      sourceDigest: draft.sourceDigest,
                      contractDigest: draft.contractDigest,
                      review: record.review,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <label>
                Source file
                <select
                  value={file}
                  onChange={(event) => {
                    setFile(event.target.value);
                    setOffset(0);
                  }}
                >
                  {draft.files.map((value) => (
                    <option key={value.path} value={value.path}>
                      {value.path}
                    </option>
                  ))}
                </select>
              </label>
              <pre
                className="agent-library-prompt agent-library-source"
                aria-label="Draft source"
                tabIndex={0}
              >
                {source.slice(offset, offset + 16000)}
              </pre>
              <div className="agent-library-actions">
                <button
                  type="button"
                  disabled={offset === 0}
                  onClick={() => setOffset((value) => Math.max(0, value - 16000))}
                >
                  Previous source page
                </button>
                <button
                  type="button"
                  disabled={offset + 16000 >= source.length}
                  onClick={() => setOffset((value) => value + 16000)}
                >
                  Next source page
                </button>
                <button type="button" onClick={download}>
                  Download review bundle
                </button>
              </div>
              {record.review && (
                <p>
                  Review feedback:{' '}
                  {record.review.feedback || 'Accepted without additional feedback.'}
                </p>
              )}
              <label>
                Review feedback
                <textarea
                  maxLength={4000}
                  value={feedback}
                  disabled={!!busy || record.status !== 'submitted'}
                  onChange={(event) => setFeedback(event.target.value)}
                />
              </label>
              <div className="agent-library-actions">
                <button
                  type="button"
                  disabled={
                    !!busy ||
                    record.status !== 'submitted' ||
                    !draft.tests.passed ||
                    !draft.tests.complete
                  }
                  onClick={() => act('accepted')}
                >
                  Accept review
                </button>
                <button
                  type="button"
                  disabled={!!busy || record.status !== 'submitted' || !feedback.trim()}
                  onClick={() => act('rejected')}
                >
                  Request changes
                </button>
                <button
                  type="button"
                  disabled={!!busy || record.status !== 'accepted' || published}
                  onClick={() => act('publish')}
                >
                  Publish accepted tool
                </button>
                <button
                  type="button"
                  disabled={!!busy || published || record.status === 'cancelled'}
                  onClick={() => act('cancel')}
                >
                  Cancel draft
                </button>
              </div>
              <p>
                Publication requires an accepted application source change with the exact
                implementation, schemas and independent tests installed on a supported runtime. It
                grants no credentials or agent assignment.
              </p>
            </>
          )}
        </section>
      </MotionPresence>
    </section>
  );
}
