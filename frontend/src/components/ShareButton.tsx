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
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    generationRef.current += 1;
    setState(busyRef.current ? 'busy' : 'idle');
    setError('');
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      clearTimeout(timerRef.current);
    };
  }, [filePath, sessionId]);

  const handleShare = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (busyRef.current) return;

      const generation = generationRef.current;
      clearTimeout(timerRef.current);
      setError('');
      busyRef.current = true;
      setState('busy');
      try {
        const initiated = await (sessionId ? shareFile(filePath, sessionId) : shareFile(filePath));
        if (!mountedRef.current || generation !== generationRef.current) return;
        setState(initiated ? 'done' : 'idle');
        if (initiated) timerRef.current = setTimeout(() => setState('idle'), 1500);
      } catch (err: unknown) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setError(err instanceof Error ? err.message : 'Could not share file. Try again.');
        setState('error');
      } finally {
        busyRef.current = false;
        if (mountedRef.current && generation !== generationRef.current) setState('idle');
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
