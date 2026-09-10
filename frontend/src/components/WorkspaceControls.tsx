import { useId, useState, type ReactNode } from 'react';
import { UiIcon } from './UiIcon';

const STORAGE_KEY = 'mitzo-workspace-controls-expanded';

export function WorkspaceControls({ children, status }: { children: ReactNode; status: string }) {
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
        <span>Workspace</span>
        <span className="workspace-controls-hint">Account, model & permissions</span>
        <span className="conversation-state">{status}</span>
        <UiIcon name={expanded ? 'up' : 'down'} />
      </button>
      <div id={id} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
