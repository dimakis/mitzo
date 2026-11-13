import { ConversationPins } from '../components/ConversationPins';
import { SessionTimersDialog } from '../components/SessionTimersDialog';
import { SessionRemovalDialog } from '../components/SessionRemovalDialog';
import { ResizableSessionLayout } from '../components/ResizableSessionLayout';
import { SessionInspector } from '../components/SessionInspector';
import { SessionContextMenu, type SessionMenuState } from '../components/SessionContextMenu';
import { SessionRenameDialog } from '../components/SessionRenameDialog';
import { SessionDetailsDialog } from '../components/SessionDetailsDialog';
import { SessionWorkLink } from '../components/SessionWorkLink';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { SessionActionPoint } from '../hooks/useSessionInteraction';
import '../styles/session-library.css';
import { SdkConversationImport } from '../components/SdkConversationImport';
import { sessionNeedsYouReason } from '../lib/session-attention';
import {
  mergeSessionActivities,
  mergeSessionModel,
  retainSessionModel,
  type ModelObservation,
} from '../lib/session-activity';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { sessionSearchTerms, type SessionSearchResult } from '@mitzo/protocol';
import { SearchMatchText } from '../components/SearchMatchText';
import { useSavedChatDrafts } from '../hooks/useSavedChatDrafts';
import { chatDraftUrl } from '../lib/chat-drafts';
import { formatRelativeTime } from '../lib/formatTime';
import '../styles/chat-drafts.css';
import type { Session } from '../types/chat';
import { SessionActivityStatus } from '../components/SessionActivityStatus';
import { useLongPress } from '../hooks/useLongPress';
import { computeSwipeState, REVEAL_WIDTH } from '../lib/swipe-reveal';
import { selectionChanged } from '../lib/haptics';
import { useSessionList } from '../hooks/useSessionList';
import { useSessionOrdering } from '../hooks/useSessionOrder';
import { useListBrowsing } from '../hooks/useListBrowsing';
import { MotionList } from '../components/MotionList';
import type { QuickAction } from '../hooks/useSessionList';
import { useSessionSearch } from '../hooks/useSessionSearch';
import { useSessionOverview, type SessionActivity } from '../hooks/useSessionOverview';
import { SessionPreview } from '../components/SessionPreview';
import { UiIcon } from '../components/UiIcon';
import { MotionDetails } from '../components/MotionDetails';

function SwipeableSession({
  session,
  snippet,
  searchQuery = '',
  matchedFields,
  activity,
  connected,
  onDismiss,
  onClick,
  onRename,
  desktop = false,
  selected = false,
  onPreview,
  onActions,
  onInteractionChange,
}: {
  session: Session;
  desktop?: boolean;
  selected?: boolean;
  onPreview?: (session: Session) => void;
  onActions?: (session: Session, trigger: HTMLElement, point?: SessionActionPoint) => void;
  onInteractionChange?: (id: string, busy: boolean) => void;
  snippet?: string;
  searchQuery?: string;
  matchedFields?: SessionSearchResult['matchedFields'];
  activity?: SessionActivity;
  connected?: boolean;
  onDismiss: (id: string) => void;
  onClick: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
  const directionLocked = useRef<'horizontal' | 'vertical' | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const moved = useRef(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onInteractionChange?.(session.id, editing || previewing || revealed);
    return () => onInteractionChange?.(session.id, false);
  }, [onInteractionChange, session.id, editing, previewing, revealed]);

  const enterEditMode = useCallback(() => {
    setEditValue(session.summary || '');
    setEditing(true);
  }, [session.summary]);

  const showPreview = useCallback(
    (point?: SessionActionPoint) => {
      if (editing) return;
      const trigger = ref.current?.querySelector<HTMLElement>('.session-item-navigation');
      trigger?.focus();
      selectionChanged();
      if (desktop && trigger) {
        onPreview?.(session);
        onActions?.(session, trigger, point);
      } else setPreviewing(true);
    },
    [editing, desktop, onPreview, onActions, session],
  );
  const closePreview = useCallback(() => setPreviewing(false), []);
  const longPress = useLongPress(showPreview);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function handleSave() {
    const trimmed = editValue.trim();
    setEditing(false);
    if (trimmed && trimmed !== session.summary) {
      onRename(session.id, trimmed);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  }

  function snapTo(x: number) {
    if (!ref.current) return;
    ref.current.style.transition = 'transform var(--motion-duration-standard) var(--motion-ease)';
    ref.current.style.transform = `translateX(${x}px)`;
    setTimeout(() => {
      if (ref.current) ref.current.style.transition = '';
    }, 200);
  }

  function closeReveal() {
    setRevealed(false);
    snapTo(0);
  }

  function handleDeleteTap(e: React.MouseEvent | React.TouchEvent) {
    e.stopPropagation();
    closeReveal();
    onDismiss(session.id);
  }

  function handleTouchStart(e: React.TouchEvent) {
    if (e.touches.length !== 1) {
      longPress.cancel();
      return;
    }
    moved.current = false;
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    currentX.current = startX.current;
    swiping.current = true;
    directionLocked.current = null;
    if (!editing) longPress.start();
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (longPress.didFire()) return;
    if (!swiping.current || !ref.current) return;
    currentX.current = e.touches[0].clientX;
    const dx = currentX.current - startX.current;
    const dy = e.touches[0].clientY - startY.current;

    if (!directionLocked.current && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      directionLocked.current = Math.abs(dy) > Math.abs(dx) ? 'vertical' : 'horizontal';
      moved.current = true;
      longPress.cancel();
    }

    if (directionLocked.current === 'vertical') return;

    if (revealed) {
      const offset = Math.min(0, -REVEAL_WIDTH + dx);
      ref.current.style.transform = `translateX(${offset}px)`;
    } else if (dx < 0) {
      const clamped = Math.max(dx, -REVEAL_WIDTH);
      ref.current.style.transform = `translateX(${clamped}px)`;
    }
  }

  function handleTouchEnd() {
    longPress.cancel();
    if (!swiping.current || !ref.current) return;
    swiping.current = false;
    if (longPress.didFire()) return;
    if (directionLocked.current === 'vertical') {
      snapTo(revealed ? -REVEAL_WIDTH : 0);
      return;
    }
    const dx = currentX.current - startX.current;

    const phase = computeSwipeState(dx, revealed);

    if (phase === 'reveal') {
      setRevealed(true);
      snapTo(-REVEAL_WIDTH);
    } else if (phase === 'close' || phase === 'idle') {
      closeReveal();
    } else {
      // dragging but didn't reach threshold — snap back
      snapTo(0);
    }
  }

  function handleClick(keyboard = false) {
    const held = longPress.consumeClick();
    const dragged = moved.current;
    moved.current = false;
    if (editing || previewing || (!keyboard && (held || dragged))) return;
    if (revealed) {
      closeReveal();
      return;
    }
    if (desktop && !keyboard) onPreview?.(session);
    else onClick(session.id);
  }

  return (
    <div className="session-item-wrapper" data-selected={selected} data-motion-key={session.id}>
      <div
        className="session-item-delete-action"
        onClick={handleDeleteTap}
        onTouchEnd={handleDeleteTap}
      >
        Delete
      </div>
      <div
        ref={ref}
        className="session-item"
        data-activity={connected !== false ? activity?.state : undefined}
        data-selected={selected}
        onDoubleClick={(event) => {
          if (event.target instanceof Element && event.target.closest('button, a, input')) return;
          if (desktop && !editing) onClick(session.id);
        }}
        onClick={() => handleClick()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={() => {
          longPress.cancel();
          swiping.current = false;
          closeReveal();
        }}
        onContextMenu={(event) => {
          if (editing) return;
          event.preventDefault();
          showPreview({ x: event.clientX, y: event.clientY });
        }}
      >
        {session.isActive && session.isAttached != null && (
          <span
            className={`session-status-dot ${session.isAttached ? 'attached' : 'detached'}`}
            role="status"
            aria-label={session.isAttached ? 'Session active' : 'Session detached'}
          />
        )}
        <div className="session-item-content">
          {editing ? (
            <input
              ref={inputRef}
              className="session-rename-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            />
          ) : (
            <div
              className="session-item-navigation"
              role={desktop ? 'button' : 'link'}
              tabIndex={0}
              aria-label={`${desktop ? 'Preview' : 'Open'} ${session.summary || 'Untitled conversation'}`}
              onFocus={() => {
                if (desktop) onPreview?.(session);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                  e.preventDefault();
                  showPreview();
                } else if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  handleClick(true);
                }
              }}
            >
              <div className="session-item-summary">
                <SearchMatchText
                  text={session.summary || 'Untitled conversation'}
                  query={searchQuery}
                />
              </div>
              {snippet && (
                <div className="conversation-result-snippet">
                  <SearchMatchText text={snippet} query={searchQuery} />
                </div>
              )}
              {!!matchedFields?.length && (
                <div className="conversation-search-evidence">
                  Matches {matchedFields.join(' · ')}
                </div>
              )}
              <div className="session-item-meta">
                {session.model && (
                  <span className="conversation-model" aria-label={`Model: ${session.model}`}>
                    <SearchMatchText text={session.model} query={searchQuery} />
                  </span>
                )}
                {session.accountLabel && (
                  <span className="conversation-account">
                    <SearchMatchText text={session.accountLabel} query={searchQuery} />
                  </span>
                )}
              </div>
              <SessionActivityStatus
                activity={activity}
                modifiedAt={session.lastModified}
                connected={connected}
              />
            </div>
          )}
          <button
            type="button"
            className="session-action-trigger conversation-row-actions"
            aria-label={`Actions for ${session.summary || 'Untitled conversation'}`}
            onClick={(event) => {
              event.stopPropagation();
              showPreview({
                x: event.currentTarget.getBoundingClientRect().right,
                y: event.currentTarget.getBoundingClientRect().bottom,
              });
            }}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <UiIcon name="more" size={16} />
          </button>
          {session.telosTaskId && <SessionWorkLink taskId={session.telosTaskId} />}
        </div>
        {!editing && (
          <span className="session-item-chevron">
            <UiIcon name="forward" size={16} />
          </span>
        )}
      </div>
      {previewing && (
        <SessionPreview
          session={session}
          activity={activity}
          connected={connected}
          onClose={closePreview}
          onOpen={() => {
            closePreview();
            onClick(session.id);
          }}
          onRename={() => {
            closePreview();
            enterEditMode();
          }}
          onDelete={() => {
            closePreview();
            closeReveal();
            onDismiss(session.id);
          }}
        />
      )}
    </div>
  );
}

export function SessionList() {
  const [timersOpen, setTimersOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const desktop = useMediaQuery('(min-width: 768px)');
  const [mobilePinPreview, setMobilePinPreview] = useState<Session | null>(null);
  const [preview, setPreview] = useState<Session | null>(null);
  const [menu, setMenu] = useState<SessionMenuState | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [details, setDetails] = useState<Session | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  const showActions = useCallback(
    (session: Session, trigger: HTMLElement, point?: SessionActionPoint) => {
      setPreview(session);
      setMenu({ session, trigger, point });
    },
    [],
  );
  const drafts = useSavedChatDrafts();
  const {
    sessions,
    quickActions,
    loading,
    error,
    loadingMore,
    hasMore,
    dismissSession,
    clearAll,
    handleRename: renameSession,
    loadMore,
    retry,
  } = useSessionList();
  const search = useSessionSearch(searchParams.get('q') ?? '');
  function setSearchQuery(query: string) {
    search.setQuery(query);
    const params = new URLSearchParams(searchParams);
    if (query) params.set('q', query);
    else params.delete('q');
    setSearchParams(params, { replace: true, state: null });
  }
  function clearSearch() {
    search.clear();
    const params = new URLSearchParams(searchParams);
    params.delete('q');
    setSearchParams(params, { replace: true, state: null });
  }
  let broaderQuery = '';
  try {
    const terms = sessionSearchTerms(search.query);
    if (search.query.includes('"')) broaderQuery = search.query.replaceAll('"', '');
    else if (terms.length > 1) broaderQuery = terms[0];
  } catch {
    /* Invalid queries retain the search error and editable input. */
  }
  const focusSearch = useCallback(
    (input: HTMLInputElement | null) => {
      if (input && location.hash === '#conversation-search') {
        input.focus();
        input.scrollIntoView?.({ block: 'center' });
      }
    },
    [location.hash],
  );
  const [importOpen, setImportOpen] = useState(false);
  const conversationOptions = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const restoredSearchScroll = useRef(false);
  useEffect(() => {
    if (!search.active || search.searching || restoredSearchScroll.current) return;
    restoredSearchScroll.current = true;
    const top = location.state?.conversationSearchScroll;
    if (typeof top === 'number' && scroller.current) scroller.current.scrollTop = top;
  }, [search.active, search.searching, search.results, location.state]);
  const [busyRows, setBusyRows] = useState(() => new Set<string>());
  const onInteractionChange = useCallback((id: string, busy: boolean) => {
    setBusyRows((previous) => {
      if (previous.has(id) === busy) return previous;
      const next = new Set(previous);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const paused = useListBrowsing(
    scroller,
    Boolean(
      menu ||
      renaming ||
      details ||
      removing ||
      mobilePinPreview ||
      importOpen ||
      search.active ||
      optionsOpen ||
      busyRows.size,
    ),
  );

  const { activities, connected, lastKnownActivities = [] } = useSessionOverview();
  const [filter, setFilter] = useState<'all' | 'active' | 'attention'>('all');
  const byId = new Map(activities.map((a) => [a.sessionId, a]));
  const displayById = new Map(
    (connected === false ? lastKnownActivities : activities).map((a) => [a.sessionId, a]),
  );
  const modelObservations = useRef(new Map<string, ModelObservation>());
  for (const result of search.results)
    retainSessionModel(modelObservations.current, result.sessionId, result);
  const combined = mergeSessionActivities(
    sessions,
    activities,
    lastKnownActivities,
    modelObservations.current,
  );
  const {
    sessions: all,
    pendingCount,
    showLatest,
  } = useSessionOrdering([...combined.values()], activities, paused);
  const active = all.filter((s) => s.isActive);
  const attention = all.filter((s) => {
    const activity = byId.get(s.id);
    return activity && sessionNeedsYouReason(activity) !== null;
  });
  const visible = filter === 'active' ? active : filter === 'attention' ? attention : all;
  const searchSessions = search.results.map((result) => {
    const existing = combined.get(result.sessionId);
    return {
      ...existing,
      id: result.sessionId,
      summary: result.summary || '',
      lastModified: result.updatedAt,
      ...retainSessionModel(
        modelObservations.current,
        result.sessionId,
        mergeSessionModel(existing, result),
      ),
      accountLabel: result.accountLabel ?? existing?.accountLabel,
      snippet: result.snippet,
      matchedFields: result.matchedFields,
    };
  });
  const currentPreview = preview
    ? (searchSessions.find((session) => session.id === preview.id) ?? combined.get(preview.id))
    : undefined;
  const selectedPreview = preview
    ? {
        ...preview,
        ...currentPreview,
        ...retainSessionModel(
          modelObservations.current,
          preview.id,
          mergeSessionModel(currentPreview, preview),
        ),
        accountLabel: currentPreview?.accountLabel ?? preview.accountLabel,
      }
    : search.active
      ? (searchSessions[0] ?? null)
      : (visible[0] ?? null);
  const previewSession = useCallback((session: Session) => setPreview(session), []);
  function openSession(id: string) {
    selectionChanged();
    if (search.active)
      navigate(location.pathname + location.search, {
        replace: true,
        state: { ...location.state, conversationSearchScroll: scroller.current?.scrollTop ?? 0 },
      });
    navigate(`/chat/${id}`, {
      state: search.active
        ? {
            conversationLibraryReturn: {
              query: search.query,
              scrollTop: scroller.current?.scrollTop ?? 0,
            },
          }
        : undefined,
    });
  }
  function dismiss(id: string) {
    setRemoving(id);
  }

  async function handleRename(id: string, title: string) {
    if (await renameSession(id, title))
      setPreview((current) => (current?.id === id ? { ...current, summary: title } : current));
  }

  function handleQuickAction(action: QuickAction) {
    const path = action.path || '/chat';
    const params = new URLSearchParams();
    if (action.prompt) params.set('prompt', action.prompt);
    if (action.cwd) params.set('cwd', action.cwd);
    if (action.extraTools) params.set('extraTools', action.extraTools);
    const qs = params.toString();
    navigate(qs ? `${path}?${qs}` : path);
  }

  return (
    <div className="session-list-page workspace-page conversation-library">
      <header className="session-list-header">
        <div className="session-list-header-title">
          <h1>Chats</h1>
        </div>
        <div className="conversation-header-actions">
          <button
            className="hero-chat-btn header-action"
            aria-label="New chat"
            onClick={() => {
              selectionChanged();
              navigate('/chat');
            }}
          >
            <UiIcon name="edit" />
            <span className="conversation-new-label">New chat</span>
          </button>
          <details
            className="conversation-options"
            onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
          >
            <summary
              ref={conversationOptions}
              aria-label="Conversation options"
              className="header-action"
            >
              <UiIcon name="more" />
            </summary>
            <div className="conversation-options-menu">
              <button
                onClick={(event) => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  setTimersOpen(true);
                }}
              >
                Timers
              </button>
              <button
                onClick={(event) => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  setImportOpen(true);
                }}
              >
                Import CLI conversation
              </button>
              {quickActions
                .filter((a) => !['Chat Session', 'Files', 'Deploy Mitzo'].includes(a.label))
                .map((a) => (
                  <button key={a.label} onClick={() => handleQuickAction(a)}>
                    {a.label}
                  </button>
                ))}
              <button
                onClick={async () => {
                  if (await clearAll()) {
                    clearSearch();
                    setPreview(null);
                    setMobilePinPreview(null);
                  }
                }}
              >
                Archive all chats
              </button>
            </div>
          </details>
        </div>
      </header>
      {timersOpen && (
        <SessionTimersDialog
          onClose={() => {
            setTimersOpen(false);
            requestAnimationFrame(() => conversationOptions.current?.focus());
          }}
        />
      )}
      <ResizableSessionLayout
        preview={
          desktop && selectedPreview ? (
            <SessionInspector
              session={selectedPreview}
              activity={displayById.get(selectedPreview.id)}
              connected={connected}
              onOpen={() => openSession(selectedPreview.id)}
              onActions={showActions}
            />
          ) : undefined
        }
      >
        <div className="session-list-scroll" ref={scroller}>
          <div className={search.active ? 'conversation-search-header' : undefined}>
            <div className="conversation-search">
              <input
                id="conversation-search"
                ref={focusSearch}
                type="search"
                aria-label="Search conversations"
                placeholder="Search conversations…"
                maxLength={512}
                aria-describedby={search.active ? 'conversation-search-help' : undefined}
                value={search.query}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {search.active && <button onClick={clearSearch}>Clear search</button>}
            </div>
            {search.active && (
              <p id="conversation-search-help" className="conversation-search-help">
                Search titles, messages, models, accounts and projects. Use quotes for an exact
                phrase.
              </p>
            )}
          </div>
          {!search.active && (
            <div className="conversation-filters" aria-label="Conversation filters">
              <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                All
              </button>
              <button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>
                Active <span>{active.length}</span>
              </button>
              <button aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')}>
                Needs you <span>{attention.length}</span>
              </button>
            </div>
          )}
          {!search.active && (
            <ConversationPins
              sessions={all}
              activities={displayById}
              connected={connected}
              selectedId={desktop ? selectedPreview?.id : undefined}
              onSelect={(id, session) => {
                if (desktop) setPreview(session);
                else openSession(id);
              }}
              onPreview={desktop ? previewSession : undefined}
              onOpen={desktop ? openSession : undefined}
              onActions={(session, trigger, point) => {
                if (desktop) showActions(session, trigger, point);
                else setMobilePinPreview(session);
              }}
            />
          )}
          {!search.active && drafts.length > 0 && (
            <MotionDetails
              className="conversation-drafts-section"
              summaryClassName="collection-section-toggle"
              summary={
                <>
                  <UiIcon name="down" size={16} />
                  <UiIcon name="edit" size={16} />
                  <span>Drafts</span>
                  <span className="conversation-drafts-count">{drafts.length}</span>
                </>
              }
            >
              {drafts.slice(0, 3).map((draft) => (
                <Link key={draft.id} to={chatDraftUrl(draft)} className="conversation-draft-row">
                  <span>{draft.text.trim().split('\n')[0].slice(0, 90) || 'Untitled draft'}</span>
                  <small>Saved {formatRelativeTime(draft.updatedAt)}</small>
                </Link>
              ))}
              <Link
                to="/sessions/drafts"
                className="conversation-drafts-all"
                aria-label={`All Drafts (${drafts.length})`}
              >
                All drafts
                <UiIcon name="forward" size={16} />
              </Link>
            </MotionDetails>
          )}
          {importOpen && (
            <SdkConversationImport
              onClose={() => {
                setImportOpen(false);
                conversationOptions.current?.focus();
              }}
              onImported={(id) => {
                setImportOpen(false);
                openSession(id);
              }}
            />
          )}
          {search.active ? (
            <div className="conversation-results" aria-live="polite">
              {!search.error && (
                <p className="conversation-list-caption">
                  {search.searching
                    ? 'Searching…'
                    : search.results.length >= 20
                      ? '20 best matches · refine your search to narrow results'
                      : `${search.results.length} results`}
                </p>
              )}
              {search.error && (
                <div className="session-list-error" role="alert">
                  <span>{search.error}</span>
                  <button type="button" onClick={search.retry}>
                    Try again
                  </button>
                </div>
              )}
              {!search.searching && !search.error && search.results.length === 0 && (
                <div className="conversation-search-empty">
                  <p className="session-list-empty">No matching conversations</p>
                  <p className="conversation-search-help">
                    Try fewer words, an account name or a project.
                  </p>
                  {broaderQuery && (
                    <button type="button" onClick={() => setSearchQuery(broaderQuery)}>
                      Search for “{broaderQuery}”
                    </button>
                  )}
                </div>
              )}
              {searchSessions.map((session) => (
                <SwipeableSession
                  key={session.id}
                  session={session}
                  snippet={session.snippet}
                  searchQuery={search.query}
                  matchedFields={session.matchedFields}
                  activity={displayById.get(session.id)}
                  connected={connected}
                  onDismiss={dismiss}
                  desktop={desktop}
                  selected={desktop && selectedPreview?.id === session.id}
                  onPreview={previewSession}
                  onActions={showActions}
                  onClick={openSession}
                  onRename={handleRename}
                />
              ))}
            </div>
          ) : (
            <>
              <p className="conversation-list-caption">
                {filter === 'all'
                  ? 'Recent conversations'
                  : filter === 'active'
                    ? 'In progress'
                    : 'Waiting for you'}
                {pendingCount > 0 && !menu && !renaming && !removing && (
                  <button
                    type="button"
                    className="session-freshness"
                    onClick={() => {
                      showLatest();
                      scroller.current
                        ?.querySelector<HTMLElement>('.session-item-navigation')
                        ?.focus({ preventScroll: true });
                    }}
                  >
                    {pendingCount} updated · show latest ↑
                  </button>
                )}
              </p>
              {loading && <p className="session-list-empty">Loading…</p>}
              {!loading && error && (
                <div className="session-list-error" role="alert">
                  <span>{error}</span>
                  <button type="button" onClick={retry}>
                    Try again
                  </button>
                </div>
              )}
              {!loading && !error && visible.length === 0 && (
                <p className="session-list-empty">
                  {filter === 'attention'
                    ? 'Nothing needs you right now'
                    : filter === 'active'
                      ? 'No active conversations'
                      : 'Start your first conversation'}
                </p>
              )}
              <MotionList className="session-list">
                {visible.map((s) => (
                  <SwipeableSession
                    key={s.id}
                    session={s}
                    activity={displayById.get(s.id)}
                    connected={connected}
                    onDismiss={dismiss}
                    desktop={desktop}
                    selected={desktop && selectedPreview?.id === s.id}
                    onPreview={previewSession}
                    onActions={showActions}
                    onClick={openSession}
                    onRename={handleRename}
                    onInteractionChange={onInteractionChange}
                  />
                ))}
              </MotionList>
              {hasMore && filter === 'all' && (
                <button className="session-load-more" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more conversations'}
                </button>
              )}
            </>
          )}
        </div>
      </ResizableSessionLayout>
      <SessionContextMenu
        state={menu}
        onClose={closeMenu}
        onOpen={() => {
          if (menu) openSession(menu.session.id);
          closeMenu();
        }}
        onRename={() => {
          if (menu) setRenaming(menu.session);
          closeMenu();
        }}
        onDelete={() => {
          if (menu) dismiss(menu.session.id);
          closeMenu();
        }}
        onDetails={() => {
          if (menu) setDetails(menu.session);
          closeMenu();
        }}
      />
      {renaming && (
        <SessionRenameDialog
          session={renaming}
          onSave={handleRename}
          onClose={() => setRenaming(null)}
        />
      )}
      {details && <SessionDetailsDialog session={details} onClose={() => setDetails(null)} />}
      {removing && (
        <SessionRemovalDialog
          sessionId={removing}
          onClose={() => setRemoving(null)}
          onRemove={async (options) => {
            const removed = await dismissSession(removing, options);
            if (removed) setPreview((current) => (current?.id === removing ? null : current));
            return removed;
          }}
        />
      )}
      {mobilePinPreview && (
        <SessionPreview
          session={mobilePinPreview}
          activity={displayById.get(mobilePinPreview.id)}
          connected={connected}
          onClose={() => setMobilePinPreview(null)}
          onOpen={() => openSession(mobilePinPreview.id)}
          onRename={() => {
            setRenaming(mobilePinPreview);
            setMobilePinPreview(null);
          }}
          onDelete={() => {
            dismiss(mobilePinPreview.id);
            setMobilePinPreview(null);
          }}
        />
      )}
    </div>
  );
}
