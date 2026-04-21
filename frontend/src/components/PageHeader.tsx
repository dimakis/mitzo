import type { ReactNode } from 'react';
import { MitzoLogo } from './MitzoLogo';

interface PageHeaderProps {
  title: string;
  badge?: number;
  center?: ReactNode;
  children?: ReactNode;
}

export function PageHeader({ title, badge, center, children }: PageHeaderProps) {
  return (
    <header className="page-header">
      <MitzoLogo />
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
