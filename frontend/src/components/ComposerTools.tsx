import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from './UiIcon';

interface Props {
  onCommands: () => void;
  commandsExpanded: boolean;
  onAttach: () => void;
  attachmentDisabled: boolean;
  onDismiss: () => void;
  isolation?: boolean;
  onIsolationChange?: (enabled: boolean) => void;
  branch?: string;
  isWorktree?: boolean;
  wtId?: string;
}

export function ComposerTools({
  onCommands,
  commandsExpanded,
  onAttach,
  attachmentDisabled,
  onDismiss,
  isolation,
  onIsolationChange,
  branch,
  isWorktree,
  wtId,
}: Props) {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const toolsId = useId();
  const toolsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toolsExpanded && !workspaceExpanded) return;
    const close = () => {
      setToolsExpanded(false);
      setWorkspaceExpanded(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!toolsRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        onDismiss();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [toolsExpanded, workspaceExpanded, onDismiss]);
  return (
    <div className="composer-tools-anchor" ref={toolsRef}>
      <button
        type="button"
        className="chat-input-btn composer-tools-toggle"
        aria-label="More composer actions"
        aria-expanded={toolsExpanded}
        aria-controls={toolsId}
        onClick={() => setToolsExpanded((value) => !value)}
      >
        <UiIcon name="more" />
      </button>
      <div id={toolsId} className="composer-tools" data-expanded={toolsExpanded}>
        <button
          className="chat-input-btn chat-input-btn--skills"
          onClick={() => {
            setToolsExpanded(false);
            onCommands();
          }}
          title="Skills"
          aria-label="Commands"
          aria-expanded={commandsExpanded}
        >
          <span aria-hidden="true">/</span>
          <span className="chat-input-command-label">Commands</span>
        </button>
        <button
          className="chat-input-btn chat-input-btn--attach"
          onClick={() => {
            setToolsExpanded(false);
            onAttach();
          }}
          disabled={attachmentDisabled}
          title="Attach image"
          aria-label="Attach image"
        >
          +<span className="composer-tools-label">Attach image</span>
        </button>
        {onIsolationChange && (
          <button
            type="button"
            className="chat-input-btn chat-input-btn--worktree"
            aria-label="Worktree isolation"
            aria-pressed={!!isolation}
            title={isolation ? 'Worktree isolation: ON' : 'Worktree isolation: OFF'}
            onClick={() => onIsolationChange(!isolation)}
          >
            <UiIcon name="worktree" />
            <span className="composer-tools-label">Isolation {isolation ? 'on' : 'off'}</span>
          </button>
        )}
        {(branch || isWorktree || wtId) && (
          <button
            type="button"
            className="chat-input-btn chat-input-btn--worktree"
            aria-label="Workspace details"
            aria-expanded={workspaceExpanded}
            title={isWorktree ? 'Isolated workspace' : 'Workspace details'}
            onClick={() => setWorkspaceExpanded((value) => !value)}
          >
            <UiIcon name="worktree" />
            <span className="composer-tools-label">Workspace</span>
          </button>
        )}
        {workspaceExpanded && (
          <dl className="composer-workspace-details">
            <dt>Workspace</dt>
            <dd>{isWorktree ? 'Isolated worktree' : 'Shared checkout'}</dd>
            {branch && (
              <>
                <dt>Branch</dt>
                <dd>{branch}</dd>
              </>
            )}
            {wtId && (
              <>
                <dt>Worktree ID</dt>
                <dd>{wtId}</dd>
              </>
            )}
          </dl>
        )}
      </div>
    </div>
  );
}
