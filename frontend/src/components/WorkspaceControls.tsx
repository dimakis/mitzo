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
    const boundary =
      chat?.querySelector<HTMLElement>('.chat-launch-prompt')?.parentElement ??
      chat?.querySelector<HTMLElement>('.chat-input');
    if (!open || !panel || !owner || !boundary || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
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
    observer.observe(owner);
    observer.observe(boundary);
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [open, attention, ref]);
  return (
    <section className="workspace-controls">
      <div className="workspace-controls-heading">
        <button
          className="workspace-controls-toggle"
          aria-label={['Workspace controls', summary?.profile, summary?.model, summary?.thinking]
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
