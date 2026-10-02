import { useState, useCallback, useRef, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { shareFile, downloadFile } from '../lib/share-file';

interface ShareButtonProps {
  filePath: string;
  sessionId?: string;
  className?: string;
}

export function ShareButton(props: ShareButtonProps) {
  return (
    <>
      {!Capacitor.isNativePlatform() && <FileActionButton {...props} action="download" />}
      <FileActionButton {...props} action="share" />
    </>
  );
}

function FileActionButton({
  filePath,
  sessionId,
  className,
  action,
}: ShareButtonProps & { action: 'share' | 'download' }) {
  const operation = action === 'download' ? downloadFile : shareFile;
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [error, setError] = useState('');
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    generationRef.current += 1;
    busyRef.current = false;
    setState('idle');
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
        const initiated = await (sessionId ? operation(filePath, sessionId) : operation(filePath));
        if (!mountedRef.current || generation !== generationRef.current) return;
        setState(initiated ? 'done' : 'idle');
        if (initiated) timerRef.current = setTimeout(() => setState('idle'), 1500);
      } catch (err: unknown) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setError(err instanceof Error ? err.message : `Could not ${action} file. Try again.`);
        setState('error');
      } finally {
        if (generation === generationRef.current) busyRef.current = false;
      }
    },
    [filePath, sessionId, operation, action],
  );

  const label =
    state === 'busy'
      ? action === 'download'
        ? 'Downloading...'
        : 'Sharing...'
      : state === 'done'
        ? action === 'download'
          ? 'Downloaded'
          : 'Shared'
        : state === 'error'
          ? 'Failed'
          : action === 'download'
            ? 'Download file'
            : 'Share file';

  const icon =
    state === 'busy'
      ? '...'
      : state === 'done'
        ? '\u2713'
        : state === 'error'
          ? '!'
          : action === 'download'
            ? '\u2193'
            : '\u21A6';

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
