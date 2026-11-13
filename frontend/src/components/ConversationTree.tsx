import type { Session } from '../types/chat';
import type { SessionActivity } from '../hooks/useSessionOverview';
import { conversationTree, type ConversationTreeNode } from '../lib/conversation-tree';
import { MotionDetails } from './MotionDetails';
import { SessionActivityStatus } from './SessionActivityStatus';
import { UiIcon } from './UiIcon';
import './ConversationTree.css';

/** Ordinary lists and native disclosure controls keep keyboard navigation and
 * focus behavior simple. Selecting a row opens its chat immediately. */
export function ConversationTree({
  sessions,
  selectedId,
  activities = new Map(),
  connected,
  onSelect,
  onActions,
}: {
  sessions: Session[];
  selectedId?: string;
  activities?: Map<string, SessionActivity>;
  connected?: boolean;
  onSelect(id: string): void;
  onActions?(session: Session, trigger: HTMLElement): void;
}) {
  const tree = conversationTree(sessions);
  function selectedPath(
    nodes: ConversationTreeNode[],
    ancestors: ConversationTreeNode[] = [],
  ): ConversationTreeNode[] {
    for (const node of nodes) {
      const path = [...ancestors, node];
      if (node.session.id === selectedId) return path;
      const found = selectedPath(node.children, path);
      if (found.length) return found;
    }
    return [];
  }
  const path = selectedPath(tree);
  const roleLabel = (session: Session) => {
    const role = session.workRole;
    if (!role) return undefined;
    const label =
      role.role === 'lead'
        ? role.level === 'outcome'
          ? 'Outcome orchestrator'
          : role.level === 'feature'
            ? 'Feature lead'
            : 'Lead'
        : role.role === 'worker'
          ? role.level === 'slice'
            ? 'Slice worker'
            : 'Worker'
          : role.role === 'advisor'
            ? 'Advisor'
            : 'Reviewer';
    return `${label}${role.assignment === 'previous' ? ' · Previous assignment' : role.assignment === 'pending' ? ' · Assignment pending' : ''}`;
  };
  const runtimeLabel = (session: Session) =>
    [
      session.agentName,
      session.engine &&
        { codex: 'Codex', 'claude-sdk': 'Claude', responses: 'Responses', gemini: 'Gemini' }[
          session.engine
        ],
      session.executionLocation &&
        (session.executionLocation === 'local' ? 'Local Mac' : 'OpenShell'),
      session.model,
    ]
      .filter(Boolean)
      .join(' · ');
  const row = (node: ConversationTreeNode) => (
    <div className="conversation-tree-row">
      <button
        type="button"
        className="conversation-tree-open"
        aria-current={node.session.id === selectedId ? 'page' : undefined}
        onClick={() => onSelect(node.session.id)}
      >
        <span>{node.session.summary || 'Untitled conversation'}</span>
        {roleLabel(node.session) && <small>{roleLabel(node.session)}</small>}
        {runtimeLabel(node.session) && <small>{runtimeLabel(node.session)}</small>}
        {node.session.runtimeUnavailable && <small>Runtime details unavailable</small>}
        <small>
          {node.unloaded ? (
            'Parent chat · not in the loaded page'
          ) : (
            <SessionActivityStatus
              activity={activities.get(node.session.id)}
              modifiedAt={node.session.lastModified}
              connected={connected}
            />
          )}
        </small>
        {node.session.treeUnavailable && <small>Relationship unavailable</small>}
      </button>
      {onActions && !node.unloaded && (
        <button
          type="button"
          className="session-action-trigger"
          aria-label={`Actions for ${node.session.summary || 'Untitled conversation'}`}
          onClick={(event) => onActions(node.session, event.currentTarget)}
        >
          <UiIcon name="more" size={16} />
        </button>
      )}
    </div>
  );
  const branch = (node: ConversationTreeNode) => (
    <li key={node.session.id}>
      {node.children.length ? (
        <MotionDetails
          defaultOpen
          summaryClassName="conversation-tree-branch"
          summary={
            <>
              <UiIcon name="down" size={16} />
              {row(node)}
            </>
          }
        >
          <ul>{node.children.map(branch)}</ul>
        </MotionDetails>
      ) : (
        row(node)
      )}
    </li>
  );
  return (
    <nav className="conversation-tree" aria-label="Conversation tree">
      {path.length > 1 && (
        <nav className="conversation-tree-path" aria-label="Current chat path">
          {path.map((node, index) => (
            <span key={node.session.id}>
              {index > 0 && <UiIcon name="forward" size={16} />}
              {node.session.id === selectedId ? (
                <span aria-current="page">{node.session.summary}</span>
              ) : (
                <button type="button" onClick={() => onSelect(node.session.id)}>
                  {node.session.summary}
                </button>
              )}
            </span>
          ))}
        </nav>
      )}
      <ul>{tree.map(branch)}</ul>
    </nav>
  );
}
