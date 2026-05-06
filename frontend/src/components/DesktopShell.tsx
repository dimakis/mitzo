import { useState, useCallback, type ReactNode } from 'react';
import { DesktopNav } from './DesktopNav';

export interface DesktopShellProps {
  left?: ReactNode;
  center: ReactNode;
  right?: ReactNode;
  statusBar?: ReactNode;
}

const STORAGE_KEY_LEFT = 'mitzo-sidebar-left-collapsed';
const STORAGE_KEY_RIGHT = 'mitzo-sidebar-right-collapsed';

function readCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function DesktopShell({ left, center, right, statusBar }: DesktopShellProps) {
  const [leftCollapsed, setLeftCollapsed] = useState(() => readCollapsed(STORAGE_KEY_LEFT));
  const [rightCollapsed, setRightCollapsed] = useState(() => readCollapsed(STORAGE_KEY_RIGHT));

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
    <div className="desktop-shell">
      <div className="desktop-body">
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
          {!leftCollapsed && (
            <>
              <DesktopNav />
              {left}
            </>
          )}
        </div>
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
