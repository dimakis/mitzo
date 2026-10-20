import { useMotionPresence } from '../hooks/useMotionPresence';
import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { UiIcon } from './UiIcon';
import type { WorkspaceSummary } from '../types/workspace';
import {
  QuickSettingsContext,
  type SettingsDestination,
  type SettingsPage,
} from '../lib/quick-settings-context';
import { QuickSettingsField } from './QuickChatSettings';

export function WorkspaceControls({
  children,
  actions,
  leading,
  trailing,
  status,
  summary,
  agent,
  title,
  settings,
  onDone,
  reviewDisabled = false,
  scopeKey,
  attention = false,
}: {
  agent?: string;
  title?: string;
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
  const [settingsPage, setSettingsPage] = useState<SettingsDestination | null>(null);
  const [summaryRoot, setSummaryRoot] = useState<HTMLDivElement | null>(null);
  const previousPage = useRef<SettingsDestination | null>(null);
  const hasSettings = !!settings;
  useEffect(() => setOpen(false), [scopeKey]);
  useEffect(() => {
    if (!open) setSettingsPage(null);
  }, [open]);
  const { ref, present } = useMotionPresence(open, hasSettings ? 'popover' : 'disclosure', false);
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
      if (settingsPage) {
        event.preventDefault();
        setSettingsPage(
          settingsPage.parent ? { key: settingsPage.parent, title: 'More options' } : null,
        );
        return;
      }
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open, ref, settingsPage]);
  useLayoutEffect(() => {
    if (!open || !hasSettings) return;
    const content = ref.current?.querySelector<HTMLElement>('.workspace-controls-content');
    if (content) content.scrollTop = 0;
    if (settingsPage)
      ref.current
        ?.querySelector<HTMLButtonElement>('.quick-settings-back')
        ?.focus({ preventScroll: true });
    else if (previousPage.current)
      ref.current
        ?.querySelector<HTMLButtonElement>(`[data-quick-setting="${previousPage.current.key}"]`)
        ?.focus({ preventScroll: true });
    previousPage.current = settingsPage;
  }, [open, hasSettings, ref, settingsPage]);
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
      const heading = owner.querySelector<HTMLElement>('.workspace-controls-heading');
      const headingGap = heading ? Number.parseFloat(getComputedStyle(heading).gap) || 0 : 0;
      // Settings measure the same structural space in both modes. Switching to an overlay
      // removes only the panel's flow contribution; it must not change the threshold
      // calculation and repeatedly switch the panel back into flow.
      const overlay = getComputedStyle(panel).position === 'absolute';
      const panelFlowHeight = overlay ? 0 : panel.getBoundingClientRect().height;
      const space =
        !hasSettings && overlay
          ? boundary.getBoundingClientRect().top - owner.getBoundingClientRect().bottom - headingGap
          : chat.clientHeight -
            (composer.getBoundingClientRect().bottom -
              chat.getBoundingClientRect().top +
              chat.scrollTop -
              panelFlowHeight -
              freeMessages);
      panel.style.setProperty('--workspace-disclosure-space', `${Math.max(0, space)}px`);
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
      if (hasSettings) {
        const top = panel.getBoundingClientRect().top;
        const aboveComposer = composer.getBoundingClientRect().top - top;
        const viewportSpace = Math.max(0, bottom - top);
        // Keep the composer clear when possible. Short/keyboard viewports retain
        // a reachable header, footer and one scrolling control row.
        panel.style.setProperty(
          '--workspace-popover-space',
          `${Math.min(viewportSpace, Math.max(6 * controlHeight, aboveComposer))}px`,
        );
      }
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
  }, [open, attention, ref, hasSettings]);
  return (
    <QuickSettingsContext.Provider
      value={hasSettings ? { page: settingsPage, navigate: setSettingsPage, summaryRoot } : null}
    >
      <section
        className={`workspace-controls${leading ? ' workspace-controls--navigation' : ''}${hasSettings ? ' workspace-controls--compact workspace-controls--quick' : ''}`}
      >
        <div className="workspace-controls-heading">
          {leading}
          {hasSettings && (
            <div className="workspace-controls-context">
              <strong className="workspace-controls-profile">
                {title ?? agent ?? summary?.profile ?? 'Chat'}
              </strong>
              <span>
                {[
                  title ? agent : undefined,
                  summary?.profile,
                  summary?.model,
                  summary?.thinking,
                  summary?.location === 'local'
                    ? 'Local Mac'
                    : summary?.location === 'openshell'
                      ? 'OpenShell'
                      : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Loading settings…'}
              </span>
            </div>
          )}
          <button
            ref={triggerRef}
            type="button"
            className="workspace-controls-toggle"
            data-attention={attention || undefined}
            aria-label={[
              'Workspace controls',
              hasSettings ? 'Settings' : undefined,
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
            {hasSettings ? (
              <>
                <UiIcon name="settings" />
                <span className="workspace-controls-label">Settings</span>
              </>
            ) : (
              <>
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
              </>
            )}
          </button>
          {hasSettings && (
            <span id={`${id}-status`} className="conversation-state sr-only">
              {status}
            </span>
          )}
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
          data-settings-page={hasSettings ? (settingsPage?.key ?? 'main') : undefined}
        >
          {settings && (
            <div className="agent-settings-header">
              {settingsPage && (
                <button
                  type="button"
                  className="quick-settings-back"
                  aria-label="Back to chat settings"
                  onClick={() =>
                    setSettingsPage(
                      settingsPage.parent
                        ? { key: settingsPage.parent, title: 'More options' }
                        : null,
                    )
                  }
                >
                  <UiIcon name="back" />
                </button>
              )}
              <strong>{settingsPage?.title ?? 'Chat settings'}</strong>
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
            <div className="workspace-controls-content workspace-controls-content--quick">
              <div ref={setSummaryRoot} className="quick-settings-summaries">
                {(
                  [
                    'account',
                    'model',
                    'thinking',
                    'agent',
                    'execution',
                    'repository',
                    'more',
                    'defaults',
                    'details',
                  ] as SettingsPage[]
                ).map((key) => (
                  <div key={key} data-settings-slot={key} />
                ))}
              </div>
              {settings}
              <QuickSettingsField page="more" title="More options" value="Permissions, web & voice">
                {children}
              </QuickSettingsField>
            </div>
          ) : (
            children
          )}
          {(settings || onDone) && (
            <div className="workspace-controls-footer">
              {hasSettings && <span className="quick-settings-footer-note">For this chat</span>}
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
    </QuickSettingsContext.Provider>
  );
}
