import { useState, useCallback, useRef, useEffect } from 'react';
import { shareFile } from '../lib/share-file';

interface ShareButtonProps {
  filePath: string;
  sessionId?: string;
  className?: string;
}

export function ShareButton({ filePath, sessionId, className }: ShareButtonProps) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    setState('idle');
    setError('');
    return () => clearTimeout(timerRef.current);
  }, [filePath, sessionId]);

  const handleShare = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (busyRef.current) return;

      clearTimeout(timerRef.current);
      setError('');
      busyRef.current = true;
      setState('busy');
      try {
        const initiated = await (sessionId ? shareFile(filePath, sessionId) : shareFile(filePath));
        setState(initiated ? 'done' : 'idle');
        if (initiated) timerRef.current = setTimeout(() => setState('idle'), 1500);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not share file. Try again.');
        setState('error');
      } finally {
        busyRef.current = false;
      }
    },
    [filePath, sessionId],
  );

  const label =
    state === 'busy'
      ? 'Sharing...'
      : state === 'done'
        ? 'Shared'
        : state === 'error'
          ? 'Failed'
          : 'Share file';

  const icon =
    state === 'busy' ? '...' : state === 'done' ? '\u2713' : state === 'error' ? '!' : '\u21A6';

  return (
    <>
      <button
        type="button"
        aria-busy={state === 'busy'}
        className={`share-btn ${className ?? ''} ${state !== 'idle' ? `share-btn--${state}` : ''}`.trim()}
        aria-label={label}
        title={error || label}
        onClick={handleShare}
        disabled={state === 'busy'}
      >
        {icon}
      </button>
      {error && (
        <span className="share-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
