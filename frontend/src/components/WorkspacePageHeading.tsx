import type { ReactNode } from 'react';

interface WorkspacePageHeadingProps {
  eyebrow?: string;
  title: string;
  description?: string;
  className?: string;
  badge?: number;
  actions?: ReactNode;
}

export function WorkspacePageHeading({
  eyebrow,
  title,
  description,
  className = '',
  badge,
  actions,
}: WorkspacePageHeadingProps) {
  return (
    <header className={`workspace-page-heading${className ? ` ${className}` : ''}`}>
      {eyebrow && <p className="workspace-eyebrow">{eyebrow}</p>}
      <div className="workspace-title-row">
        <h1>
          {title}
          {!!badge && <span className="workspace-count">{badge}</span>}
        </h1>
        {actions && <div className="workspace-heading-actions">{actions}</div>}
      </div>
      {description && <p className="workspace-muted">{description}</p>}
    </header>
  );
}
