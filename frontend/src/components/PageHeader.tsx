import type { ReactNode } from 'react';
import { MitzoLogo } from './MitzoLogo';
import { UiIcon } from './UiIcon';

interface PageHeaderProps {
  title: string;
  badge?: number;
  center?: ReactNode;
  children?: ReactNode;
  onBack?: () => void;
}

export function PageHeader({ title, badge, center, children, onBack }: PageHeaderProps) {
  return (
    <header className="page-header">
      {onBack ? (
        <button className="page-header-back" onClick={onBack} aria-label="Back">
          <UiIcon name="back" size={16} />
        </button>
      ) : (
        <MitzoLogo />
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
