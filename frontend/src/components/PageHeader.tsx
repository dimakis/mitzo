import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  onBack?: () => void;
  badge?: number;
  center?: ReactNode;
  children?: ReactNode;
}

export function PageHeader({ title, onBack, badge, center, children }: PageHeaderProps) {
  return (
    <header className="page-header">
      {onBack && (
        <button className="page-header-back" onClick={onBack} title="Back">
          {'\u2039'}
        </button>
      )}
      {center ? (
        <div className="page-header-center">{center}</div>
      ) : (
        <h1>
          {title}
          {badge ? <span className="page-header-badge">{badge}</span> : null}
        </h1>
      )}
      {children && <div className="page-header-actions">{children}</div>}
    </header>
  );
}
