import { useMotionPresence } from '../hooks/useMotionPresence';
import { useEffect, useLayoutEffect, useId, useState, type ReactNode } from 'react';
import { UiIcon } from './UiIcon';
import type { WorkspaceSummary } from '../types/workspace';

const STORAGE_KEY = 'mitzo-workspace-controls-expanded';

export function WorkspaceControls({
  children,
  actions,
  status,
  summary,
  attention = false,
}: {
  attention?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  status: string;
  summary?: WorkspaceSummary | null;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [reviewExpanded, setReviewExpanded] = useState(attention);
  useEffect(() => setReviewExpanded(attention), [attention]);
  const open = expanded || reviewExpanded;
  const { ref, present } = useMotionPresence(open, 'disclosure', false);
  useLayoutEffect(() => {
    const panel = ref.current;
    const owner = panel?.parentElement;
    const chat = owner?.closest('.workspace-chat');
    if (!open || !panel || !owner || !chat || typeof ResizeObserver === 'undefined') return;
    const observed = new Set<Element>();
    const measure = () => {
      const composer = chat.querySelector<HTMLElement>('.chat-input');
      const boundary =
        chat.querySelector<HTMLElement>('.chat-launch-prompt')?.parentElement ??
        chat.querySelector<HTMLElement>('.repository-chat-picker') ??
        composer;
      // Composer growth can move the repository row without resizing that row.
      const next = new Set<Element>([
        owner,
        chat,
        ...[boundary, composer].filter((node): node is HTMLElement => !!node),
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
      if (getComputedStyle(panel).position !== 'absolute') {
        panel.style.removeProperty('--workspace-disclosure-space');
        return;
      }
      const heading = owner.querySelector<HTMLElement>('.workspace-controls-heading');
      const gap = heading ? Number.parseFloat(getComputedStyle(heading).gap) || 0 : 0;
      const space = Math.max(
        0,
        boundary.getBoundingClientRect().top - owner.getBoundingClientRect().bottom - gap,
      );
      panel.style.setProperty('--workspace-disclosure-space', `${space}px`);
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
    <section className="workspace-controls">
      <div className="workspace-controls-heading">
        <button
          className="workspace-controls-toggle"
          aria-label={[
            'Workspace controls',
            summary?.profile,
            summary?.model,
            summary?.thinking,
            summary?.location,
          ]
            .filter(Boolean)
            .join(', ')}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            const next = !open;
            setReviewExpanded(false);
            setExpanded(next);
            try {
              localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
            } catch {
              /* optional preference */
            }
          }}
        >
          <UiIcon name="settings" />
          <span className="workspace-controls-summary">
            {summary ? (
              <>
                <span className="workspace-controls-profile">{summary.profile}</span>
                {(summary.model || summary.thinking) && (
                  <span className="workspace-controls-details">
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
          <span className="conversation-state">{status}</span>
          <UiIcon name={open ? 'up' : 'down'} />
        </button>
        {actions}
      </div>
      <div
        id={id}
        ref={ref}
        className="motion-disclosure"
        hidden={!present}
        inert={!open}
        aria-hidden={!open || undefined}
      >
        {children}
      </div>
    </section>
  );
}
