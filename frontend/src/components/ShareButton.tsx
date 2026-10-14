import { UiIcon } from './UiIcon';
import { useState, useCallback, useRef, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { shareFile, downloadFile } from '../lib/share-file';
import { HomeDialog } from './HomeDialog';
import { useMotionPresence } from '../hooks/useMotionPresence';

interface ShareButtonProps {
  filePath: string;
  sessionId?: string;
  className?: string;
  onOpen?: () => void;
}

/** One quiet trigger keeps the available file actions out of the reading surface. */
export function ShareButton({ filePath, sessionId, className, onOpen }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<'share' | 'download'>('share');
  const { ref: motionRef, present } = useMotionPresence(open, 'popover', false);
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
    setOpen(false);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      clearTimeout(timerRef.current);
    };
  }, [filePath, sessionId]);

  const handleAction = useCallback(
    async (e: React.MouseEvent, action: 'share' | 'download') => {
      e.preventDefault();
      e.stopPropagation();
      if (busyRef.current) return;

      const operation = action === 'download' ? downloadFile : shareFile;
      setAction(action);
      const generation = generationRef.current;
      clearTimeout(timerRef.current);
      setError('');
      busyRef.current = true;
      setState('busy');
      try {
        const initiated = await (sessionId ? operation(filePath, sessionId) : operation(filePath));
        if (!mountedRef.current || generation !== generationRef.current) return;
        setState(initiated ? 'done' : 'idle');
        if (initiated) setOpen(false);
        if (initiated) timerRef.current = setTimeout(() => setState('idle'), 1500);
      } catch (err: unknown) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setError(err instanceof Error ? err.message : `Could not ${action} file. Try again.`);
        setState('error');
      } finally {
        if (generation === generationRef.current) busyRef.current = false;
      }
    },
    [filePath, sessionId],
  );

  const trigger = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.focus({ preventScroll: true });
    setOpen(true);
  };
  const button = (choice: 'share' | 'download') => {
    const activeState = choice === action ? state : 'idle';
    const label =
      activeState === 'busy'
        ? choice === 'download'
          ? 'Downloading...'
          : 'Sharing...'
        : activeState === 'done'
          ? choice === 'download'
            ? 'Downloaded'
            : 'Shared'
          : activeState === 'error'
            ? 'Failed'
            : choice === 'download'
              ? 'Download file'
              : 'Share file';
    const icon =
      activeState === 'busy'
        ? 'loading'
        : activeState === 'done'
          ? 'check'
          : activeState === 'error'
            ? 'error'
            : choice;
    return (
      <button
        type="button"
        className="home-secondary file-action-choice"
        aria-label={label}
        aria-busy={activeState === 'busy'}
        disabled={state === 'busy'}
        onClick={(e) => void handleAction(e, choice)}
      >
        <UiIcon name={icon} size={16} />
        {activeState === 'idle' ? (choice === 'download' ? 'Download' : 'Share') : label}
      </button>
    );
  };

  return (
    <>
      <button
        type="button"
        className={`share-btn file-options-trigger ${className ?? ''}`.trim()}
        aria-label="File options"
        title={error || 'File options'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={state === 'busy'}
        onClick={trigger}
      >
        <UiIcon
          name={
            state === 'busy'
              ? 'loading'
              : state === 'error'
                ? 'error'
                : state === 'done'
                  ? 'check'
                  : 'more'
          }
          size={16}
        />
      </button>
      {present && (
        <HomeDialog
          title="File options"
          className="file-actions-dialog"
          inactive={!open}
          onClose={() => setOpen(false)}
        >
          <div
            ref={motionRef}
            className="file-action-choices"
            inert={!open}
            aria-hidden={!open || undefined}
          >
            {onOpen && (
              <button
                type="button"
                className="home-secondary file-action-choice"
                disabled={state === 'busy'}
                onClick={() => {
                  setOpen(false);
                  onOpen();
                }}
              >
                <UiIcon name="file" size={16} />
                Open
              </button>
            )}
            {!Capacitor.isNativePlatform() && button('download')}
            {button('share')}
            {Capacitor.isNativePlatform() && <p>Share also offers Save to Files.</p>}
            {error && (
              <span className="share-error" role="alert">
                {error}
              </span>
            )}
          </div>
        </HomeDialog>
      )}
    </>
  );
}

/** Saved filenames open in Mitzo; one adjacent trigger holds every extra action. */
export function FileShareLink({
  children,
  onOpen,
  ...props
}: ShareButtonProps & { children: React.ReactNode; onOpen: () => void }) {
  return (
    <span className="file-path-group">
      <a
        href="#"
        className="artifact-share-link"
        onClick={(event) => {
          event.preventDefault();
          onOpen();
        }}
      >
        {children}
      </a>
      <ShareButton {...props} onOpen={onOpen} />
    </span>
  );
}
