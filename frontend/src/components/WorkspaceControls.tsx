import { useMotionPresence } from '../hooks/useMotionPresence';
import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { UiIcon } from './UiIcon';
import type { WorkspaceSummary } from '../types/workspace';

export function WorkspaceControls({
  children,
  actions,
  leading,
  trailing,
  status,
  summary,
  agent,
  settings,
  onDone,
  reviewDisabled = false,
  scopeKey,
  attention = false,
}: {
  agent?: string;
  settings?: ReactNode;
  onDone?: () => void;
  reviewDisabled?: boolean;
  scopeKey?: string;
  attention?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  status: string;
  summary?: WorkspaceSummary | null;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [scopeKey]);
  const { ref, present } = useMotionPresence(open, 'disclosure', false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !event.composedPath().includes(triggerRef.current!) &&
        !event.composedPath().includes(ref.current!)
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      // Nested dialogs and popovers get first refusal of Escape.
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open, ref]);
  useLayoutEffect(() => {
    const panel = ref.current;
    const owner = panel?.parentElement;
    const chat = owner?.closest('.workspace-chat');
    if (!open || !panel || !owner || !chat || typeof ResizeObserver === 'undefined') return;
    const observed = new Set<Element>();
    const measure = () => {
      const composer = chat.querySelector<HTMLElement>('.chat-input');
      const messages = chat.querySelector<HTMLElement>('.chat-messages');
      const boundaryCandidate =
        chat.querySelector<HTMLElement>('.chat-launch-prompt')?.parentElement ??
        chat.querySelector<HTMLElement>('.repository-chat-picker') ??
        composer;
      const boundary =
        boundaryCandidate && panel.contains(boundaryCandidate) ? composer : boundaryCandidate;
      // Composer growth can move the repository row without resizing that row.
      const next = new Set<Element>([
        owner,
        chat,
        ...[boundary, composer, messages].filter((node): node is HTMLElement => !!node),
      ]);
      for (const node of observed)
        if (!next.has(node)) {
          observer.unobserve(node);
          observed.delete(node);
        }
      for (const node of next)
        if (!observed.has(node)) {
          observer.observe(node);
          observed.add(node);
        }
      if (!boundary) return;
      let space: number;
      if (getComputedStyle(panel).position === 'absolute') {
        const heading = owner.querySelector<HTMLElement>('.workspace-controls-heading');
        const gap = heading ? Number.parseFloat(getComputedStyle(heading).gap) || 0 : 0;
        space = boundary.getBoundingClientRect().top - owner.getBoundingClientRect().bottom - gap;
      } else {
        if (!composer) return;
        const style = messages ? getComputedStyle(messages) : null;
        const minimumMessages = style
          ? ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce(
              (height, property) =>
                height +
                (Number.parseFloat(style[property as keyof CSSStyleDeclaration] as string) || 0),
              0,
            )
          : 0;
        const freeMessages = messages
          ? Math.max(0, messages.getBoundingClientRect().height - minimumMessages)
          : 0;
        // Reserve the actual repository/composer flow, even when a hidden ancestor
        // has been scrolled by textarea focus. Flexible transcript space can shrink.
        space =
          chat.clientHeight -
          (composer.getBoundingClientRect().bottom -
            chat.getBoundingClientRect().top +
            chat.scrollTop -
            panel.getBoundingClientRect().height -
            freeMessages);
      }
      panel.style.setProperty('--workspace-disclosure-space', `${Math.max(0, space)}px`);
      const heading = owner.querySelector<HTMLElement>('.workspace-controls-heading');
      const viewport = window.visualViewport;
      const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const navigation = document.querySelector('.workspace-tabs')?.getBoundingClientRect();
      const center = chat.closest('.desktop-center')?.getBoundingClientRect();
      const bottom = Math.min(
        viewportBottom,
        chat.getBoundingClientRect().bottom,
        center?.bottom ?? viewportBottom,
        navigation?.height ? navigation.top : viewportBottom,
      );
      panel.style.setProperty(
        '--workspace-disclosure-viewport-space',
        `${Math.max(0, bottom - (heading ?? owner).getBoundingClientRect().bottom)}px`,
      );
      const controlHeight = Number.parseFloat(
        getComputedStyle(owner).getPropertyValue('--control-height'),
      );
      panel.toggleAttribute('data-constrained', space < 6 * controlHeight);
    };
    const observer = new ResizeObserver(measure);
    // Account selection and repository preparation can add a new launch surface
    // without resizing the composer. Keep its actions outside the overlay.
    const mutations = new MutationObserver(measure);
    mutations.observe(chat, { childList: true, subtree: true });
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [open, attention, ref]);
  return (
    <section className={`workspace-controls${leading ? ' workspace-controls--navigation' : ''}`}>
      <div className="workspace-controls-heading">
        {leading}
        <button
          ref={triggerRef}
          type="button"
          className="workspace-controls-toggle"
          data-attention={attention || undefined}
          aria-label={[
            'Workspace controls',
            agent,
            summary?.profile,
            summary?.model,
            summary?.thinking,
            summary?.location,
          ]
            .filter(Boolean)
            .join(', ')}
          aria-describedby={`${id}-status`}
          aria-expanded={open}
          aria-controls={id}
          onClick={(event) => {
            event.currentTarget.focus();
            setOpen(!open);
          }}
        >
          <UiIcon name={agent ? 'bot' : 'settings'} />
          <span className="workspace-controls-summary">
            {summary ? (
              <>
                <span className="workspace-controls-profile">{agent ?? summary.profile}</span>
                {(agent || summary.model || summary.thinking) && (
                  <span className="workspace-controls-details">
                    {agent && <span>{summary.profile}</span>}
                    {summary.model && <span>{summary.model}</span>}
                    {summary.location && (
                      <span>{summary.location === 'local' ? 'Local' : 'OpenShell'}</span>
                    )}
                    {summary.thinking && <span>{summary.thinking}</span>}
                  </span>
                )}
              </>
            ) : (
              <span>Loading profile…</span>
            )}
          </span>
          <span
            id={`${id}-status`}
            className={`conversation-state${leading ? ' sr-only' : ''}`}
            title={status}
          >
            {status}
          </span>
          <UiIcon name={open ? 'up' : 'down'} />
        </button>
        {actions}
        {trailing}
      </div>
      <div
        id={id}
        ref={ref}
        className={`motion-disclosure${settings ? ' workspace-controls-settings' : ''}`}
        role={settings ? 'region' : undefined}
        aria-label={settings ? 'Agent settings' : undefined}
        hidden={!present}
        inert={!open}
        aria-hidden={!open || undefined}
      >
        {settings && (
          <div className="agent-settings-header">
            <strong>Chat settings</strong>
            <button
              type="button"
              aria-label="Close agent settings"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }}
            >
              <UiIcon name="close" />
            </button>
          </div>
        )}
        {settings ? (
          <div className="workspace-controls-content">
            {settings}
            <details className="workspace-controls-options">
              <summary>More options</summary>
              {children}
            </details>
          </div>
        ) : (
          children
        )}
        {(settings || onDone) && (
          <div className="workspace-controls-footer">
            <button
              type="button"
              disabled={reviewDisabled}
              onClick={() => {
                onDone?.();
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }}
            >
              Done <UiIcon name="check" />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
