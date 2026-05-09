import { useState, type ReactNode } from 'react';

export interface CollapsibleSectionProps {
  title: string;
  badge?: number;
  storageKey: string;
  children: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
}

function readCollapsed(key: string, defaultOpen: boolean): boolean {
  try {
    const val = localStorage.getItem(key);
    if (val === null) return !defaultOpen;
    return val === '1';
  } catch {
    return !defaultOpen;
  }
}

export function CollapsibleSection({
  title,
  badge,
  storageKey,
  children,
  defaultOpen = true,
  actions,
}: CollapsibleSectionProps) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey, defaultOpen));

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  return (
    <div className="cc-section">
      <button className="cc-section-header" onClick={toggle}>
        <span className="cc-section-title">{title}</span>
        {badge !== undefined && badge > 0 && <span className="cc-section-badge">{badge}</span>}
        {actions && (
          <span className="cc-section-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
        <span className={`cc-section-chevron${collapsed ? '' : ' cc-section-chevron--open'}`}>
          &rsaquo;
        </span>
      </button>
      {!collapsed && <div className="cc-section-body">{children}</div>}
    </div>
  );
}
