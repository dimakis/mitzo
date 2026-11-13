import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { HomeDialog } from './HomeDialog';
import { UiIcon } from './UiIcon';
import './SnapSheet.css';

/** Native modal ownership, with a mobile grip and keyboard-equivalent sizing. */
export function SnapSheet({
  title,
  onClose,
  onBack,
  backLabel,
  className,
  children,
  initialSnap = 'half',
}: {
  title: string;
  onClose(): void;
  onBack?(): void;
  backLabel?: string;
  className?: string;
  children: ReactNode;
  initialSnap?: 'half' | 'full';
}) {
  const surface = useRef<HTMLDialogElement>(null);
  const [snap, setSnap] = useState<'half' | 'full'>(() =>
    window.matchMedia?.('(max-width: 640px)').matches === false ? 'half' : initialSnap,
  );
  const drag = useRef<{ y: number; height: number; current: number } | null>(null);
  useLayoutEffect(() => {
    if (surface.current) surface.current.dataset.snap = snap;
  }, [snap]);
  const clearDrag = () => {
    drag.current = null;
    surface.current?.style.removeProperty('--snap-sheet-drag-height');
    surface.current?.removeAttribute('data-dragging');
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (!surface.current || event.button !== 0) return;
    const height = surface.current.getBoundingClientRect().height;
    drag.current = { y: event.clientY, height, current: height };
    surface.current.dataset.dragging = 'true';
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current.current = Math.max(
      0,
      Math.min(
        window.visualViewport?.height ?? window.innerHeight,
        drag.current.height + drag.current.y - event.clientY,
      ),
    );
    surface.current?.style.setProperty('--snap-sheet-drag-height', `${drag.current.current}px`);
  };
  const finish = () => {
    if (!drag.current) return;
    const ratio = drag.current.current / (window.visualViewport?.height ?? window.innerHeight);
    clearDrag();
    if (ratio < 0.25) onClose();
    else setSnap(ratio > 0.75 ? 'full' : 'half');
  };
  return (
    <HomeDialog
      title={title}
      onClose={onClose}
      onBack={onBack}
      backLabel={backLabel}
      closeLabel="Hide agent chat"
      className={`snap-sheet ${className ?? ''}`}
      surfaceRef={surface}
      headerActions={
        <div className="snap-sheet-controls">
          <button
            type="button"
            className="header-action"
            aria-label="Half screen"
            aria-pressed={snap === 'half'}
            onClick={() => {
              clearDrag();
              setSnap('half');
            }}
          >
            <UiIcon name="minus" />
          </button>
          <button
            type="button"
            className="header-action"
            aria-label="Full screen"
            aria-pressed={snap === 'full'}
            onClick={() => {
              clearDrag();
              setSnap('full');
            }}
          >
            <UiIcon name="arrowUpRight" />
          </button>
        </div>
      }
    >
      <div
        className="snap-sheet-grip"
        aria-hidden="true"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={clearDrag}
      />
      {children}
    </HomeDialog>
  );
}
