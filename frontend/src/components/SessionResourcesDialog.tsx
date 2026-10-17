import { AgentLibrarySourceContext } from './AgentLibraryChatSource';
import { ConversationWorkLinks } from './SessionWorkLink';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionOutputReference } from '@mitzo/protocol';
import type { SessionTrayProps } from './SessionTray';
import {
  collectSessionResources,
  mergeSessionResources,
  REFERENCE_ROLES,
  type ReferenceRole,
  type SessionResource,
} from '../lib/session-resources';
import { readApiJson } from '../lib/api-json-read';
import { MAX_IMAGE_ATTACHMENTS } from '../lib/constants';
import { collectMockups } from '../lib/mockup-catalog';
import { MockupCollection } from './MockupCollection';
import { HomeDialog } from './HomeDialog';
import { UiIcon } from './UiIcon';
import { ContextPanel } from './ContextPanel';
import { SessionBanner } from './SessionBanner';
import { CompactionDetails } from './CompactionMarker';
import { compactionLabel } from '../lib/compaction-presentation';
import type { ContextCompaction } from '@mitzo/protocol';

type Tab = 'Sources' | 'Context' | 'Outputs' | 'References' | 'Mockups';
type Detail = {
  title: string;
  resource?: SessionResource;
  content?: string;
  error?: string;
  loading?: boolean;
  compaction?: ContextCompaction;
};
const PAGE_SIZE = 8;
function domainOf(resource: SessionResource) {
  try {
    return resource.href ? new URL(resource.href).hostname : 'Workspace';
  } catch {
    return 'Other references';
  }
}
const isPr = (resource: SessionResource) =>
  !!resource.href && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(resource.href);

/** Read-only session evidence with local paging; opening a mention grants no new access. */
export function SessionResourcesDialog(props: SessionTrayProps) {
  const {
    sessionId,
    messages,
    current,
    bootContext,
    sessionContext,
    selectedContextBlocks,
    draftImages,
    onToggleContextBlock,
    onAddImages,
    onRemoveImage,
    onPreviewImage,
    getDraftImageKey,
    contextRemovalOnly,
  } = props;
  const [open, setOpen] = useState(false),
    [tab, setTab] = useState<Tab>('Sources'),
    [detail, setDetail] = useState<Detail | null>(null);
  const [category, setCategory] = useState<ReferenceRole | 'all'>('all'),
    [search, setSearch] = useState(''),
    [domain, setDomain] = useState<string | null>(null),
    [page, setPage] = useState(0);
  const [outputView, setOutputView] = useState<{
    sessionId: string;
    outputs: SessionOutputReference[];
    error?: string;
    loading: boolean;
  } | null>(null);
  const [outputAttempt, setOutputAttempt] = useState(0);
  const body = useRef<HTMLDivElement>(null),
    scroll = useRef(0),
    opener = useRef<HTMLElement | null>(null),
    categoryMenu = useRef<HTMLDetailsElement>(null);
  const detailOperation = useRef<AbortController | null>(null),
    ids = useId();
  const mockups = useMemo(() => collectMockups(messages), [messages]);
  const finished = useMemo(() => collectSessionResources(messages), [messages]);
  const streaming = useMemo(() => collectSessionResources([], current), [current]);
  const resources = useMemo(
    () => mergeSessionResources(finished, streaming),
    [finished, streaming],
  );
  const references = useMemo(
    () =>
      resources.references.filter(
        (resource) =>
          (category === 'all' || resource.roles?.includes(category)) &&
          `${resource.label} ${resource.href ?? resource.path ?? ''}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [resources, category, search],
  );
  const domains = useMemo(() => [...new Set(references.map(domainOf))], [references]);
  const pages = domain ? references.filter((resource) => domainOf(resource) === domain) : [];
  const count = domain ? pages.length : domains.length;
  const pageCount = Math.max(1, Math.ceil(count / PAGE_SIZE)),
    currentPage = Math.min(page, pageCount - 1);
  const outputs = outputView?.sessionId === sessionId ? outputView : null;
  useEffect(() => {
    setOpen(false);
    setDetail(null);
    setOutputView(null);
    return () => detailOperation.current?.abort();
  }, [sessionId]);
  useLayoutEffect(() => {
    if (!detail && body.current) {
      body.current.scrollTop = scroll.current;
      opener.current?.focus({ preventScroll: true });
    }
  }, [detail]);
  useEffect(() => {
    if (!open || tab !== 'Outputs' || !sessionId) return;
    const controller = new AbortController();
    setOutputView((previous) => ({
      sessionId,
      outputs: previous?.sessionId === sessionId ? previous.outputs : [],
      loading: true,
    }));
    void readApiJson<{ outputs: SessionOutputReference[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/outputs`,
      controller.signal,
    )
      .then((value) => {
        if (
          !Array.isArray(value.outputs) ||
          !value.outputs.every(
            (output) =>
              output.sessionId === sessionId &&
              output.source?.sessionId === sessionId &&
              typeof output.title === 'string' &&
              typeof output.outputId === 'string' &&
              output.durability === 'reference_registered',
          )
        )
          throw Error('Invalid output evidence');
        if (!controller.signal.aborted)
          setOutputView({ sessionId, outputs: value.outputs, loading: false });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setOutputView((previous) => ({
            sessionId,
            outputs: previous?.sessionId === sessionId ? previous.outputs : [],
            loading: false,
            error: 'Retained outputs could not be checked. Retry.',
          }));
      });
    return () => controller.abort();
  }, [open, tab, sessionId, outputAttempt]);
  const close = () => {
    detailOperation.current?.abort();
    if (detail) setDetail(null);
    else setOpen(false);
  };
  const inspect = (value: Detail, trigger: HTMLElement) => {
    scroll.current = body.current?.scrollTop ?? 0;
    opener.current = trigger;
    setDetail(value);
  };
  const inspectOutput = (output: SessionOutputReference, trigger: HTMLElement) => {
    detailOperation.current?.abort();
    const controller = new AbortController();
    detailOperation.current = controller;
    inspect({ title: output.title, loading: true }, trigger);
    void readApiJson<{ output: SessionOutputReference; content: string | null }>(
      `/api/sessions/${encodeURIComponent(sessionId!)}/outputs/${encodeURIComponent(output.outputId)}`,
      controller.signal,
    )
      .then((value) => {
        if (value.output?.sessionId !== sessionId || value.output.outputId !== output.outputId)
          throw Error('Output mismatch');
        if (!controller.signal.aborted)
          setDetail({
            title: output.title,
            content: value.content ?? undefined,
            error:
              value.content === null ? 'The original source is no longer available.' : undefined,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setDetail({
            title: output.title,
            error: 'Output source could not be read. Return to Resources and retry.',
          });
      });
  };
  const row = (resource: SessionResource) => (
    <div className="chat-resource-row" key={resource.id}>
      {resource.preview ? (
        <img src={resource.preview} alt="" />
      ) : isPr(resource) ? (
        <span className="github-brand" aria-hidden="true" />
      ) : (
        <UiIcon
          name={
            resource.kind === 'image'
              ? 'image'
              : resource.kind === 'context'
                ? 'layers'
                : resource.kind === 'file'
                  ? 'file'
                  : 'connections'
          }
        />
      )}
      <button
        type="button"
        onClick={(event) => inspect({ title: resource.label, resource }, event.currentTarget)}
      >
        <strong>{resource.label}</strong>
        <small>
          {isPr(resource)
            ? `${resource.pullRequest?.state ?? 'Status not checked'} · GitHub`
            : (resource.roles ?? []).map((role) => REFERENCE_ROLES[role]).join(' · ')}
        </small>
        {!!resource.mentions && (
          <small>
            {resource.mentions} mention{resource.mentions === 1 ? '' : 's'}
          </small>
        )}
      </button>
      <UiIcon name="forward" size={16} />
    </div>
  );
  return (
    <>
      <button
        type="button"
        className="chat-input-btn composer-session-trigger"
        aria-label="Open session tray"
        title="Session resources"
        aria-expanded={open}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        <UiIcon name="files" />
        {draftImages.length + selectedContextBlocks.length > 0 && (
          <span className="composer-resource-count">
            {draftImages.length + selectedContextBlocks.length}
          </span>
        )}
      </button>
      {open && (
        <HomeDialog
          title={detail ? detail.title : 'Resources'}
          className="chat-resource-dialog"
          onClose={close}
        >
          {detail && (
            <div className="chat-resource-detail">
              <button type="button" className="chat-resource-back" onClick={close}>
                <UiIcon name="back" size={16} />
                Back to Resources
              </button>
              {detail.loading && <p role="status">Loading output…</p>}
              {detail.error && <p role="alert">{detail.error}</p>}
              {detail.compaction && (
                <CompactionDetails
                  record={detail.compaction}
                  onJump={() => {
                    const id = detail.compaction!.id;
                    setDetail(null);
                    setOpen(false);
                    requestAnimationFrame(() =>
                      document
                        .getElementById(`chat-compaction-${id}`)
                        ?.scrollIntoView({ block: 'center' }),
                    );
                  }}
                />
              )}
              {detail.content && <pre>{detail.content}</pre>}
              {detail.resource && (
                <>
                  {isPr(detail.resource) && (
                    <>
                      <p>
                        <span className="github-brand" aria-hidden="true" /> Pull request ·{' '}
                        {detail.resource.pullRequest?.state ?? 'Status not checked'}
                      </p>
                      <p>Checks not reported</p>
                      <p>Review status not reported</p>
                      <p>
                        {detail.resource.pullRequest?.observedAt
                          ? `Last observed ${new Date(detail.resource.pullRequest.observedAt).toLocaleString()}`
                          : 'URL recorded in this session; no status observation was reported.'}
                      </p>
                      {detail.resource.pullRequest?.commit && (
                        <p>
                          Observed commit <code>{detail.resource.pullRequest.commit}</code>
                        </p>
                      )}
                      <p>Updated from verified session results. No background polling.</p>
                    </>
                  )}
                  {detail.resource.preview && (
                    <img
                      className="chat-resource-image"
                      src={detail.resource.preview}
                      alt={detail.resource.label}
                    />
                  )}
                  {detail.resource.path && <pre>{detail.resource.path}</pre>}
                  {detail.resource.kind === 'context' &&
                    (detail.resource.content !== undefined ? (
                      <pre>{detail.resource.content}</pre>
                    ) : (
                      <p>The submitted content is not available in this session record.</p>
                    ))}
                  {detail.resource.href && (
                    <a href={detail.resource.href} target="_blank" rel="noreferrer">
                      {isPr(detail.resource) ? 'Open on GitHub' : 'Open reference'}{' '}
                      <UiIcon name="external" size={16} />
                    </a>
                  )}
                  <p className="workspace-muted">
                    {(detail.resource.roles ?? []).map((role) => REFERENCE_ROLES[role]).join(' · ')}
                  </p>
                  {detail.resource.messageIds?.length && (
                    <p className="workspace-muted">
                      Recorded in {detail.resource.messageIds.length} message
                      {detail.resource.messageIds.length === 1 ? '' : 's'}. A mention does not prove
                      the page was opened.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          <div className="chat-resource-main" hidden={!!detail}>
            <div className="chat-resource-tabs" role="tablist" aria-label="Resource type">
              {(['Sources', 'Context', 'Outputs', 'Mockups', 'References'] as Tab[]).map(
                (value) => (
                  <button
                    type="button"
                    key={value}
                    role="tab"
                    id={`${ids}-${value}`}
                    aria-controls={`${ids}-body`}
                    aria-selected={value === tab}
                    onClick={() => {
                      scroll.current = 0;
                      setTab(value);
                    }}
                  >
                    {value}
                  </button>
                ),
              )}
            </div>
            <div
              ref={body}
              id={`${ids}-body`}
              className="chat-resource-body"
              role="tabpanel"
              aria-labelledby={`${ids}-${tab}`}
            >
              {tab === 'Sources' && (
                <>
                  <AgentLibrarySourceContext
                    sources={[
                      ...(props.sourceSnapshots ?? []),
                      ...messages.flatMap((message) => message.sourceSnapshots ?? []),
                    ]}
                  />
                  {sessionId && <ConversationWorkLinks conversationId={sessionId} />}
                  <h3>Next prompt</h3>
                  {draftImages.map((image, index) => (
                    <div
                      className="chat-resource-row"
                      key={getDraftImageKey?.(image) ?? image.preview}
                    >
                      <button
                        type="button"
                        className="chat-resource-draft"
                        aria-label={`Preview pasted image ${index + 1}`}
                        onClick={(event) => {
                          event.currentTarget.focus();
                          onPreviewImage?.(image);
                        }}
                      >
                        <img src={image.preview} alt="" />
                        <span>Pasted image {index + 1}</span>
                      </button>
                      <button
                        type="button"
                        className="chat-resource-remove"
                        aria-label={`Remove pasted image ${index + 1}`}
                        onClick={() => onRemoveImage(index)}
                      >
                        <UiIcon name="close" size={16} />
                      </button>
                    </div>
                  ))}
                  {!draftImages.length && (
                    <p className="workspace-muted">No draft images attached.</p>
                  )}
                  <button
                    type="button"
                    onClick={onAddImages}
                    disabled={draftImages.length >= MAX_IMAGE_ATTACHMENTS}
                  >
                    <UiIcon name="plus" size={16} />
                    Add images
                  </button>
                  <h3>Already sent</h3>
                  {resources.sources.map(row)}
                  {!resources.sources.length && (
                    <p className="workspace-muted">No images or context blocks sent yet.</p>
                  )}
                </>
              )}
              {tab === 'Context' && (
                <>
                  <h3>Compaction history</h3>
                  {props.compactionError && <p role="status">{props.compactionError}</p>}
                  {props.compactionTruncated && (
                    <p className="workspace-muted">
                      Showing recent compaction records; earlier records are not included.
                    </p>
                  )}
                  {(props.compactions ?? []).map((record) => (
                    <button
                      type="button"
                      key={record.id}
                      className="chat-reference-domain"
                      onClick={(event) =>
                        inspect(
                          { title: 'Context compaction', compaction: record },
                          event.currentTarget,
                        )
                      }
                    >
                      <UiIcon name="compact" size={16} />
                      <span>
                        {compactionLabel(record)}
                        <small>
                          {new Date(record.observedAt).toLocaleTimeString()}
                          {record.turnIndex !== null ? ` · agent request ${record.turnIndex}` : ''}
                        </small>
                      </span>
                      <UiIcon name="forward" size={16} />
                    </button>
                  ))}
                  {!props.compactions?.length && !props.compactionError && (
                    <p className="workspace-muted">
                      No positioned compaction records were reported. Older sessions may only report
                      a count.
                    </p>
                  )}
                  <h3>Injected context</h3>
                  {bootContext || sessionContext ? (
                    <SessionBanner bootContext={bootContext} sessionContext={sessionContext} />
                  ) : (
                    <p className="workspace-muted">
                      No boot or session context was reported for this conversation.
                    </p>
                  )}
                  <h3>Context blocks · {selectedContextBlocks.length} selected</h3>
                  <ContextPanel
                    selected={selectedContextBlocks}
                    onToggle={onToggleContextBlock}
                    removalOnly={contextRemovalOnly}
                  />
                  <p className="workspace-muted">
                    Selected blocks go with the next prompt. Selection does not mean the provider
                    has received them.
                  </p>
                </>
              )}
              {tab === 'Mockups' && (
                <MockupCollection key={sessionId} mockups={mockups} sessionId={sessionId} />
              )}
              {tab === 'Outputs' && (
                <>
                  <p className="workspace-muted">
                    Explicitly registered outputs retained in this conversation. Mentioned URLs and
                    paths remain References.
                  </p>
                  {outputs?.loading && <p role="status">Checking retained outputs…</p>}
                  {outputs?.error && <p role="alert">{outputs.error}</p>}
                  {outputs?.outputs.map((output) => (
                    <div className="chat-resource-row" key={output.outputId}>
                      <UiIcon name="file" />
                      <button
                        type="button"
                        onClick={(event) => inspectOutput(output, event.currentTarget)}
                      >
                        <strong>{output.title}</strong>
                        <small>
                          {output.label} ·{' '}
                          {output.sourceAvailability === 'available'
                            ? 'Source available'
                            : 'Source unavailable'}
                        </small>
                      </button>
                      <UiIcon name="forward" size={16} />
                    </div>
                  ))}
                  {!outputs?.loading && !outputs?.error && !outputs?.outputs.length && (
                    <p>No retained outputs yet.</p>
                  )}
                  {sessionId && (
                    <button
                      type="button"
                      disabled={outputs?.loading}
                      onClick={() => setOutputAttempt((value) => value + 1)}
                    >
                      <UiIcon name="retry" size={16} />
                      Refresh outputs
                    </button>
                  )}
                </>
              )}
              {tab === 'References' && (
                <>
                  <details ref={categoryMenu} className="chat-resource-filter">
                    <summary>
                      <span>
                        {category === 'all' ? 'All reference types' : REFERENCE_ROLES[category]}
                      </span>
                      <UiIcon name="down" size={16} />
                    </summary>
                    {(['all', ...Object.keys(REFERENCE_ROLES)] as Array<ReferenceRole | 'all'>).map(
                      (value) => (
                        <button
                          type="button"
                          key={value}
                          aria-pressed={category === value}
                          onClick={() => {
                            setCategory(value);
                            setDomain(null);
                            setPage(0);
                            if (categoryMenu.current) categoryMenu.current.open = false;
                          }}
                        >
                          {value === 'all' ? 'All reference types' : REFERENCE_ROLES[value]}
                        </button>
                      ),
                    )}
                  </details>
                  <label className="chat-resource-search">
                    Search references
                    <input
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setDomain(null);
                        setPage(0);
                      }}
                    />
                  </label>
                  <p className="workspace-muted">
                    {references.length} references · {domains.length} websites / locations. Repeated
                    URLs share one record with multiple roles.
                  </p>
                  {domain ? (
                    <>
                      <button
                        type="button"
                        className="chat-resource-back"
                        onClick={() => {
                          setDomain(null);
                          setPage(0);
                        }}
                      >
                        <UiIcon name="back" size={16} />
                        All websites
                      </button>
                      <h3>{domain}</h3>
                      {pages.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(row)}
                    </>
                  ) : (
                    domains
                      .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
                      .map((host) => (
                        <button
                          type="button"
                          key={host}
                          className="chat-reference-domain"
                          data-testid="reference-domain"
                          onClick={() => {
                            setDomain(host);
                            setPage(0);
                          }}
                        >
                          <UiIcon name={host === 'Workspace' ? 'files' : 'connections'} size={16} />
                          <span>
                            {host}
                            <small>
                              {references.filter((resource) => domainOf(resource) === host).length}{' '}
                              references
                            </small>
                          </span>
                          <UiIcon name="forward" size={16} />
                        </button>
                      ))
                  )}
                  {!references.length && <p>No matching references.</p>}
                  {pageCount > 1 && (
                    <div className="chat-resource-paging">
                      <button
                        type="button"
                        aria-label="Previous references"
                        disabled={currentPage === 0}
                        onClick={() => setPage(currentPage - 1)}
                      >
                        <UiIcon name="back" />
                      </button>
                      <span>
                        {currentPage + 1} / {pageCount}
                      </span>
                      <button
                        type="button"
                        aria-label="Next references"
                        disabled={currentPage === pageCount - 1}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        <UiIcon name="forward" />
                      </button>
                    </div>
                  )}
                  <details>
                    <summary>Observed tool names</summary>
                    <p className="workspace-muted">
                      Seen in this conversation; current availability is not established.
                    </p>
                    {resources.capabilities.map((resource) => (
                      <p key={resource.id}>{resource.label}</p>
                    ))}
                  </details>
                </>
              )}
            </div>
          </div>
        </HomeDialog>
      )}
    </>
  );
}
