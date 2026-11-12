import { useId, useState, type ReactNode } from 'react';
import { MotionPresence } from './MotionPresence';
import { UiIcon, type UiIconName } from './UiIcon';
import '../styles/operation-card.css';

export function OperationCard({
  title,
  kind,
  icon = 'work',
  scope,
  actions,
  status,
  tone = 'normal',
  pending = false,
  children,
  details,
  detailsLabel = 'Details',
  toggleLabel,
  initiallyExpanded = false,
  className = '',
  label,
  busy = false,
  expanded: controlledExpanded,
  onExpandedChange,
}: {
  title: ReactNode;
  kind: string;
  icon?: UiIconName;
  scope?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  tone?: 'normal' | 'error';
  pending?: boolean;
  children?: ReactNode;
  details?: ReactNode;
  detailsLabel?: string;
  toggleLabel?: string;
  initiallyExpanded?: boolean;
  className?: string;
  label?: string;
  busy?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [localExpanded, setExpanded] = useState(initiallyExpanded);
  const expanded = controlledExpanded ?? localExpanded;
  const id = useId();
  return (
    <section
      className={`operation-card${pending ? ' operation-card--pending' : ' operation-card--settled'}${tone === 'error' ? ' operation-card--error' : ''} ${className}`}
      aria-label={label ?? (typeof title === 'string' ? title : kind)}
      aria-busy={busy}
    >
      <div className="operation-header">
        <div className="operation-identity">
          <div className="operation-kind">
            <UiIcon name={icon} size={16} />
            <span>{kind}</span>
          </div>
          <h3 className="operation-title">{title}</h3>
          {scope && <div className="operation-scope">{scope}</div>}
        </div>
        {(actions || status) && (
          <div className="operation-actions">
            {actions && <div className="operation-action-controls">{actions}</div>}
            {status && <span className="operation-status">{status}</span>}
          </div>
        )}
      </div>
      {children && (
        <div className="operation-content" tabIndex={-1}>
          {children}
        </div>
      )}
      {details && (
        <>
          <button
            type="button"
            className="operation-details-toggle"
            aria-label={toggleLabel ?? `Details for ${typeof title === 'string' ? title : kind}`}
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => {
              setExpanded(!expanded);
              onExpandedChange?.(!expanded);
            }}
          >
            <UiIcon name={expanded ? 'down' : 'forward'} size={16} />
            {detailsLabel}
          </button>
          <MotionPresence open={expanded} kind="disclosure" appear={false}>
            <div id={id} className="operation-details">
              {details}
            </div>
          </MotionPresence>
        </>
      )}
    </section>
  );
}
