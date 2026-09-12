import { useState, useCallback, type ReactNode } from 'react';
import { UiIcon } from './UiIcon';
import { DesktopNav } from './DesktopNav';
import { MitzoBrand } from './MitzoBrand';

export interface DesktopShellProps {
  left?: ReactNode;
  center: ReactNode;
  right?: ReactNode;
  statusBar?: ReactNode;
  rightDefaultCollapsed?: boolean;
}

const STORAGE_KEY_LEFT = 'mitzo-sidebar-left-collapsed';
const STORAGE_KEY_RIGHT = 'mitzo-sidebar-right-collapsed';

function readCollapsed(key: string, fallback = false): boolean {
  try {
    const saved = localStorage.getItem(key);
    return saved === null ? fallback : saved === '1';
  } catch {
    return fallback;
  }
}

export function DesktopShell({
  left,
  center,
  right,
  statusBar,
  rightDefaultCollapsed = false,
}: DesktopShellProps) {
  const [railCollapsed, setRailCollapsed] = useState(() =>
    readCollapsed('mitzo-navigation-collapsed'),
  );
  const [leftCollapsed, setLeftCollapsed] = useState(() => readCollapsed(STORAGE_KEY_LEFT));
  const [rightCollapsed, setRightCollapsed] = useState(() =>
    readCollapsed(STORAGE_KEY_RIGHT, rightDefaultCollapsed),
  );

  const toggleLeft = useCallback(() => {
    setLeftCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY_LEFT, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const toggleRight = useCallback(() => {
    setRightCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY_RIGHT, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <div className="desktop-shell workspace-shell">
      <div className="desktop-body">
        <aside className={`workspace-rail${railCollapsed ? ' workspace-rail--collapsed' : ''}`}>
          <div className="workspace-rail-heading">
            <MitzoBrand compact={railCollapsed} />
          </div>
          <div className="workspace-rail-controls">
            <button
              className="workspace-rail-toggle"
              aria-label={railCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              title={railCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              aria-expanded={!railCollapsed}
              onClick={() => {
                const next = !railCollapsed;
                setRailCollapsed(next);
                try {
                  localStorage.setItem('mitzo-navigation-collapsed', next ? '1' : '0');
                } catch {
                  /* optional preference */
                }
              }}
            >
              <UiIcon name="panel" />
            </button>
          </div>
          <DesktopNav />
        </aside>
        {left && (
          <div
            className={`desktop-sidebar-left${leftCollapsed ? ' desktop-sidebar--collapsed' : ''}`}
          >
            <button
              className="desktop-collapse-btn"
              onClick={toggleLeft}
              title={leftCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              {leftCollapsed ? '\u25B6' : '\u25C0'}
            </button>
            {!leftCollapsed && <>{left}</>}
          </div>
        )}
        <div className="desktop-center">{center}</div>
        {right && (
          <div
            className={`desktop-sidebar-right${rightCollapsed ? ' desktop-sidebar--collapsed' : ''}`}
          >
            <button
              className="desktop-collapse-btn"
              onClick={toggleRight}
              title={rightCollapsed ? 'Show context' : 'Hide context'}
            >
              {rightCollapsed ? '\u25C0' : '\u25B6'}
            </button>
            {!rightCollapsed && right}
          </div>
        )}
      </div>
      {statusBar && <div className="desktop-status-row">{statusBar}</div>}
    </div>
  );
}
