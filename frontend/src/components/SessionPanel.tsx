import { useCallback, useState } from 'react';
import type { Session } from '../types/chat';
import { UiIcon } from './UiIcon';
import { useSessionList } from '../hooks/useSessionList';
import { useSessionOverview, type SessionActivity } from '../hooks/useSessionOverview';
import { useSessionSearch } from '../hooks/useSessionSearch';
import { useSessionInteraction, type SessionActionPoint } from '../hooks/useSessionInteraction';
import { SessionSearchBar } from './SessionSearchBar';
import { ActiveSessionsList } from './ActiveSessionsList';
import { ConversationPins } from './ConversationPins';
import { SessionContextMenu, type SessionMenuState } from './SessionContextMenu';
import { SessionRemovalDialog } from './SessionRemovalDialog';
import { SessionRenameDialog } from './SessionRenameDialog';
import { SessionDetailsDialog } from './SessionDetailsDialog';
import { SessionWorkLink } from './SessionWorkLink';
import { formatRelativeTime } from '../lib/formatTime';
import { recordTitle } from '../lib/record-title';
import '../styles/session-library.css';
export interface SessionPanelProps {
  activeSessionId: string | undefined;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
}
type ViewMode = 'active' | 'all';
const STORAGE_KEY = 'mitzo-session-view-mode';
function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'all' ? 'all' : 'active';
  } catch {
    return 'active';
  }
}
type Actions = (session: Session, trigger: HTMLElement, point?: SessionActionPoint) => void;
function SessionPanelRow({
  session,
  active,
  activity,
  onSelect,
  onActions,
}: {
  session: Session;
  active: boolean;
  activity?: SessionActivity;
  onSelect: (id: string) => void;
  onActions: Actions;
}) {
  const handlers = useSessionInteraction(
    () => onSelect(session.id),
    (trigger, point) => onActions(session, trigger, point),
  );
  const title = recordTitle(session.summary || 'Untitled session');
  return (
    <div className={`session-panel-item${active ? ' session-panel-item--active' : ''}`}>
      <button
        type="button"
        className="session-panel-select"
        {...handlers}
        aria-current={active || undefined}
      >
        <span className="session-panel-item-text">
          <span className="session-panel-item-summary">{title}</span>
          <span className="session-panel-item-meta">
            {activity && <span>{activity.awaitingReply ? 'Awaiting reply' : activity.state}</span>}
            <span className="session-panel-item-time">
              {formatRelativeTime(session.lastModified)}
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        className="session-action-trigger"
        aria-label={`Actions for ${title}`}
        onClick={(event) => onActions(session, event.currentTarget)}
      >
        <UiIcon name="more" size={16} />
      </button>
      {session.telosTaskId && <SessionWorkLink taskId={session.telosTaskId} />}
    </div>
  );
}
export function SessionPanel({ activeSessionId, onSelectSession, onNewChat }: SessionPanelProps) {
  const {
    sessions,
    loading,
    error,
    retry,
    loadingMore,
    hasMore,
    loadMore,
    dismissSession,
    handleRename,
  } = useSessionList();
  const search = useSessionSearch();
  const { activities, attendCount } = useSessionOverview();
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [menu, setMenu] = useState<SessionMenuState | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [details, setDetails] = useState<Session | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const showActions = useCallback<Actions>(
    (session, trigger, point) => setMenu({ session, trigger, point }),
    [],
  );
  function activityActions(
    activity: SessionActivity,
    trigger: HTMLElement,
    point?: SessionActionPoint,
  ) {
    showActions(
      sessions.find((session) => session.id === activity.sessionId) ?? {
        id: activity.sessionId,
        summary: activity.title,
        lastModified: activity.lastEventAt,
      },
      trigger,
      point,
    );
  }
  function switchView(mode: ViewMode) {
    setViewMode(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* Keep the selector usable without storage. */
    }
  }
  return (
    <div className="session-panel">
      <div className="session-panel-heading">
        <h1>Conversations</h1>
        <SessionSearchBar {...search} onSelectSession={onSelectSession} />
      </div>
      <button type="button" className="session-panel-new" onClick={onNewChat}>
        <UiIcon name="edit" size={16} />
        New Chat
      </button>
      <div className="session-view-toggle">
        <button
          type="button"
          className={viewMode === 'active' ? 'active' : ''}
          aria-pressed={viewMode === 'active'}
          onClick={() => switchView('active')}
        >
          Active{attendCount > 0 && <span className="session-view-badge">{attendCount}</span>}
        </button>
        <button
          type="button"
          className={viewMode === 'all' ? 'active' : ''}
          aria-pressed={viewMode === 'all'}
          onClick={() => switchView('all')}
        >
          All
        </button>
      </div>
      <ConversationPins
        sessions={sessions}
        selectedId={activeSessionId}
        onSelect={onSelectSession}
        onActions={showActions}
      />
      {viewMode === 'active' ? (
        <ActiveSessionsList
          activeSessionId={activeSessionId}
          onSelectSession={onSelectSession}
          onActions={activityActions}
        />
      ) : (
        <>
          {loading && <p className="session-panel-empty">Loading...</p>}
          {!loading && error && (
            <div className="session-panel-empty" role="alert">
              <p>{error}</p>
              <button type="button" onClick={retry}>
                Try again
              </button>
            </div>
          )}
          {!loading && !error && sessions.length === 0 && (
            <p className="session-panel-empty">No sessions</p>
          )}
          {!loading && sessions.length > 0 && (
            <div className="session-panel-list">
              <h2 className="session-list-group-title">All conversations</h2>
              {sessions.map((session) => (
                <SessionPanelRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  activity={activities.find((activity) => activity.sessionId === session.id)}
                  onSelect={onSelectSession}
                  onActions={showActions}
                />
              ))}
              {hasMore && (
                <button
                  type="button"
                  className="session-load-more"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading...' : 'Load More'}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <SessionContextMenu
        state={menu}
        onClose={closeMenu}
        onOpen={() => {
          if (menu) onSelectSession(menu.session.id);
          closeMenu();
        }}
        onRename={() => {
          if (menu) setRenaming(menu.session);
          closeMenu();
        }}
        onDelete={() => {
          if (menu) setRemoving(menu.session.id);
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
          onRemove={(options) => dismissSession(removing, options)}
        />
      )}
    </div>
  );
}
