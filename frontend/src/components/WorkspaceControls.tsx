import { useId, useState, type ReactNode } from 'react';
import { UiIcon } from './UiIcon';
import type { WorkspaceSummary } from '../types/workspace';

const STORAGE_KEY = 'mitzo-workspace-controls-expanded';

export function WorkspaceControls({
  children,
  status,
  summary,
}: {
  children: ReactNode;
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
  return (
    <section className="workspace-controls">
      <button
        className="workspace-controls-toggle"
        aria-label={['Workspace controls', summary?.profile, summary?.model, summary?.thinking]
          .filter(Boolean)
          .join(', ')}
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => {
          const next = !expanded;
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
        <UiIcon name={expanded ? 'up' : 'down'} />
      </button>
      <div id={id} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
