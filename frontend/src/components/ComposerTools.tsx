import { Link, useInRouterContext } from 'react-router-dom';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { UiIcon } from './UiIcon';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { MotionPresence } from './MotionPresence';
import './ComposerTools.css';

interface Props {
  /** Mounted secondary controls share the overflow; primary send/stop actions stay outside. */
  children?: ReactNode;
  terminalHref?: string;
  onCommands: () => void;
  commandsExpanded: boolean;
  commandsDisabled?: boolean;
  onAttach: () => void;
  attachmentDisabled: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  onDismiss: () => void;
  onSchedule?: () => void;
  isolation?: boolean;
  onIsolationChange?: (enabled: boolean) => void;
  branch?: string;
  isWorktree?: boolean;
  wtId?: string;
}

export function ComposerTools({
  children,
  onCommands,
  commandsExpanded,
  commandsDisabled,
  onAttach,
  attachmentDisabled,
  expanded,
  onExpand,
  onDismiss,
  onSchedule,
  isolation,
  onIsolationChange,
  branch,
  isWorktree,
  wtId,
  terminalHref,
}: Props) {
  const inRouter = useInRouterContext();
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const [inline, setInline] = useState(true);
  const open = inline || toolsExpanded;
  const { ref: motionRef, present } = useMotionPresence(toolsExpanded, 'popover', false, !inline);
  const visible = inline || present;
  const toolsId = useId();
  const toolsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const anchor = toolsRef.current;
    if (!anchor) return;
    // The container query owns the breakpoint; CSS also reports its layout mode.
    const update = () => {
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      anchor.style.setProperty(
        '--composer-tools-space',
        `${Math.max(0, anchor.getBoundingClientRect().top - viewportTop - 8)}px`,
      );
      const next =
        getComputedStyle(anchor).getPropertyValue('--composer-tools-layout').trim() !== 'popover';
      // A resize must not leave keyboard focus in newly hidden overflow content.
      if (!next && !toolsExpanded && motionRef.current?.contains(document.activeElement))
        triggerRef.current?.focus({ preventScroll: true });
      setInline(next);
    };
    update();
    const container = anchor.closest('.chat-input--compact') ?? anchor;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(container);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [toolsExpanded, motionRef]);
  useLayoutEffect(() => {
    if (inline && document.activeElement === triggerRef.current)
      motionRef.current
        ?.querySelector<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)')
        ?.focus({ preventScroll: true });
  }, [inline, motionRef]);
  useEffect(() => {
    if (!toolsExpanded && !workspaceExpanded) return;
    const close = () => {
      setToolsExpanded(false);
      setWorkspaceExpanded(false);
    };
    const dismissOutside = (event: Event) => {
      // HomeDialog portals remain mounted outside this DOM subtree. Keep the
      // originating control reachable when the dialog restores focus.
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
      if (!toolsRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        event.preventDefault();
        if (inline) onDismiss();
        else triggerRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [toolsExpanded, workspaceExpanded, inline, onDismiss]);
  return (
    <div
      className={`composer-tools-anchor${children ? ' composer-tools-anchor--secondary' : ''}`}
      ref={toolsRef}
    >
      <button
        type="button"
        className="chat-input-btn composer-tools-toggle"
        ref={triggerRef}
        aria-label="More composer actions"
        aria-expanded={toolsExpanded}
        aria-controls={toolsId}
        onClick={() => setToolsExpanded((value) => !value)}
      >
        <UiIcon name="more" />
      </button>
      <div
        id={toolsId}
        ref={motionRef}
        className="composer-tools"
        data-expanded={!inline && present}
        hidden={!visible}
        inert={!open}
        aria-hidden={!open || undefined}
      >
        <button
          className="chat-input-btn chat-input-btn--skills"
          onClick={() => {
            setToolsExpanded(false);
            onCommands();
          }}
          title="Commands"
          aria-label="Commands"
          aria-expanded={commandsExpanded}
          disabled={commandsDisabled}
        >
          <UiIcon name="command" size={16} />
          <span className="chat-input-command-label">Commands</span>
        </button>
        <button
          className="chat-input-btn chat-input-btn--attach"
          onClick={() => {
            setToolsExpanded(false);
            onAttach();
          }}
          disabled={attachmentDisabled}
          title="Attach images or PDF"
          aria-label="Attach images or PDF"
        >
          <UiIcon name="plus" size={16} />
          <span className="composer-tools-label">Attach images or PDF</span>
        </button>
        {onSchedule && (
          <button
            type="button"
            className="chat-input-btn"
            aria-label="Schedule prompt"
            title="Schedule prompt"
            onClick={() => {
              setToolsExpanded(false);
              onSchedule();
            }}
          >
            <UiIcon name="clock" />
            <span className="composer-tools-label">Schedule prompt</span>
          </button>
        )}
        {terminalHref &&
          (inRouter ? (
            <Link
              className="chat-input-btn"
              aria-label="Terminal"
              to={terminalHref}
              onClick={() => setToolsExpanded(false)}
            >
              <UiIcon name="terminal" />
              <span className="composer-tools-label">Terminal</span>
            </Link>
          ) : (
            <a
              className="chat-input-btn"
              aria-label="Terminal"
              href={terminalHref}
              onClick={() => setToolsExpanded(false)}
            >
              <UiIcon name="terminal" />
              <span className="composer-tools-label">Terminal</span>
            </a>
          ))}
        {!terminalHref && (
          <button
            type="button"
            className="chat-input-btn"
            disabled
            aria-label="Terminal"
            title="Terminal is unavailable before a supported session or for this runtime"
          >
            <UiIcon name="terminal" />
            <span className="composer-tools-label">Terminal · unavailable for this route</span>
          </button>
        )}
        {onExpand && (
          <button
            type="button"
            className="chat-input-btn"
            aria-label={expanded ? 'Shrink input' : 'Expand input'}
            aria-pressed={expanded}
            onClick={() => {
              setToolsExpanded(false);
              onExpand();
              onDismiss();
            }}
          >
            <UiIcon name={expanded ? 'fullscreenExit' : 'fullscreen'} />
            <span className="composer-tools-label">
              {expanded ? 'Shrink input' : 'Expand input'}
            </span>
          </button>
        )}
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
        <MotionPresence open={workspaceExpanded} appear={false}>
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
        </MotionPresence>
        {children}
      </div>
    </div>
  );
}
