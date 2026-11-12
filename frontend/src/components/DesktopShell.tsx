import type { ReactNode } from 'react';
import { UiIcon } from './UiIcon';
import { DesktopNav } from './DesktopNav';
import { MitzoBrand } from './MitzoBrand';
import { ResizeDivider } from './ResizeDivider';
import { useDesktopPanelLayout } from '../hooks/useDesktopPanelLayout';
import { layoutStorageNotice, useLayoutPreference } from '../hooks/useLayoutPreference';
import { panelLimits, type DesktopPanel, type PanelModes } from '../lib/desktop-panel-layout';

export interface DesktopShellProps {
  left?: ReactNode;
  center: ReactNode;
  right?: ReactNode;
  statusBar?: ReactNode;
  rightDefaultCollapsed?: boolean;
  leftDefaultCollapsed?: boolean;
}

const STORAGE_KEY_LEFT = 'mitzo-sidebar-left-collapsed';
const STORAGE_KEY_RIGHT = 'mitzo-sidebar-right-collapsed';

const decodeCollapsed = (value: string) => value === '1';
const encodeCollapsed = (value: boolean) => (value ? '1' : '0');

export function DesktopShell({
  left,
  center,
  right,
  statusBar,
  rightDefaultCollapsed = false,
  leftDefaultCollapsed = false,
}: DesktopShellProps) {
  const [railCollapsed, setRailCollapsed, railUnavailable] = useLayoutPreference(
    'mitzo-navigation-collapsed',
    false,
    decodeCollapsed,
    encodeCollapsed,
  );
  const [leftCollapsed, setLeftCollapsed, leftUnavailable] = useLayoutPreference(
    STORAGE_KEY_LEFT,
    leftDefaultCollapsed,
    decodeCollapsed,
    encodeCollapsed,
  );
  const [rightCollapsed, setRightCollapsed, rightUnavailable] = useLayoutPreference(
    STORAGE_KEY_RIGHT,
    rightDefaultCollapsed,
    decodeCollapsed,
    encodeCollapsed,
  );
  const modes: PanelModes = {
    navigation: railCollapsed ? 'collapsed' : 'expanded',
    conversations: !left ? 'absent' : leftCollapsed ? 'collapsed' : 'expanded',
    resources: !right ? 'absent' : rightCollapsed ? 'collapsed' : 'expanded',
  };
  const layout = useDesktopPanelLayout(modes);
  function divider(panel: DesktopPanel, direction: 1 | -1 = 1) {
    return (
      modes[panel] === 'expanded' && (
        <ResizeDivider
          label={`Resize ${panel}`}
          value={layout.widths[panel]}
          min={panelLimits[panel].min}
          max={layout.maximum(panel)}
          direction={direction}
          onChange={(value) => layout.resize(panel, value)}
          onReset={() => layout.resize(panel, panelLimits[panel].default)}
        />
      )
    );
  }

  return (
    <div className="desktop-shell workspace-shell">
      <div className="desktop-body" ref={layout.container} style={layout.style}>
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
              onClick={() => setRailCollapsed(!railCollapsed)}
            >
              <UiIcon name="panel" />
            </button>
          </div>
          <DesktopNav />
        </aside>
        {divider('navigation')}
        {left && (
          <>
            <div
              className={`desktop-sidebar-left${leftCollapsed ? ' desktop-sidebar--collapsed' : ''}`}
            >
              <button
                className="desktop-collapse-btn"
                onClick={() => setLeftCollapsed(!leftCollapsed)}
                title={leftCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              >
                <UiIcon name={leftCollapsed ? 'panelLeft' : 'panelLeftClose'} size={16} />
              </button>
              {!leftCollapsed && <>{left}</>}
            </div>
            {divider('conversations')}
          </>
        )}
        <div className="desktop-center">{center}</div>
        {right && (
          <>
            {divider('resources', -1)}
            <div
              className={`desktop-sidebar-right${rightCollapsed ? ' desktop-sidebar--collapsed' : ''}`}
            >
              <button
                className="desktop-collapse-btn"
                onClick={() => setRightCollapsed(!rightCollapsed)}
                title={rightCollapsed ? 'Show context' : 'Hide context'}
              >
                <UiIcon name={rightCollapsed ? 'panelRight' : 'panelRightClose'} size={16} />
              </button>
              {!rightCollapsed && right}
            </div>
          </>
        )}
      </div>
      {(statusBar ||
        layout.unavailable ||
        railUnavailable ||
        leftUnavailable ||
        rightUnavailable) && (
        <div className="desktop-status-row">
          {(layout.unavailable || railUnavailable || leftUnavailable || rightUnavailable) && (
            <p role="status" className="layout-storage-notice">
              {layoutStorageNotice}
            </p>
          )}
          {statusBar}
        </div>
      )}
    </div>
  );
}
