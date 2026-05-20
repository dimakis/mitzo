import { useState, useCallback } from 'react';
import { shareFile } from '../lib/share-file';

interface ShareButtonProps {
  filePath: string;
  className?: string;
}

export function ShareButton({ filePath, className }: ShareButtonProps) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  const handleShare = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (state === 'busy') return;

      setState('busy');
      try {
        await shareFile(filePath);
        setState('done');
        setTimeout(() => setState('idle'), 1500);
      } catch {
        setState('error');
        setTimeout(() => setState('idle'), 2000);
      }
    },
    [filePath, state],
  );

  const label =
    state === 'busy'
      ? 'Sharing...'
      : state === 'done'
        ? 'Shared'
        : state === 'error'
          ? 'Failed'
          : 'Share file';

  const icon = state === 'busy' ? '...' : state === 'done' ? '\u2713' : state === 'error' ? '!' : '\u21A6';

  return (
    <button
      className={`share-btn ${className ?? ''} ${state !== 'idle' ? `share-btn--${state}` : ''}`.trim()}
      aria-label={label}
      title={label}
      onClick={handleShare}
      disabled={state === 'busy'}
    >
      {icon}
    </button>
  );
}
