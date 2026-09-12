interface WorkspacePageHeadingProps {
  eyebrow?: string;
  title: string;
  description?: string;
  className?: string;
}

export function WorkspacePageHeading({
  eyebrow,
  title,
  description,
  className = '',
}: WorkspacePageHeadingProps) {
  return (
    <header className={`workspace-page-heading${className ? ` ${className}` : ''}`}>
      {eyebrow && <p className="workspace-eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {description && <p className="workspace-muted">{description}</p>}
    </header>
  );
}
