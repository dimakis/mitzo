import { Link } from 'react-router-dom';

interface MitzoBrandProps {
  compact?: boolean;
  className?: string;
}

export function MitzoBrand({ compact = false, className = '' }: MitzoBrandProps) {
  return (
    <Link
      to="/"
      className={`mitzo-brand${compact ? ' mitzo-brand--compact' : ''}${className ? ` ${className}` : ''}`}
      aria-label="Mitzo home"
    >
      <img src={compact ? '/mitzo-icon.png' : '/mitzo-wordmark.png'} alt="" aria-hidden="true" />
    </Link>
  );
}
