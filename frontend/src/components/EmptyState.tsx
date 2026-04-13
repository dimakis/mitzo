import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: string;
  title: string;
  subtitle?: ReactNode;
}

export function EmptyState({ icon, title, subtitle }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <p className="empty-state-title">{title}</p>
      {subtitle && <p className="empty-state-subtitle">{subtitle}</p>}
    </div>
  );
}
