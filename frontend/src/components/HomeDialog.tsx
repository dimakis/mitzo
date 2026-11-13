import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { UiIcon } from './UiIcon';
import '../styles/home.css';
import '../styles/header-actions.css';
import { animateMotion } from '../lib/motion';
import { useReducedMotion } from '../hooks/useReducedMotion';

const bodyScrollLocks = new WeakMap<HTMLElement, { owners: Set<symbol>; overflow: string }>();

function lockBodyScroll() {
  const body = document.body;
  const lock = bodyScrollLocks.get(body) ?? {
    owners: new Set<symbol>(),
    overflow: body.style.overflow,
  };
  bodyScrollLocks.set(body, lock);
  const owner = Symbol();
  lock.owners.add(owner);
  body.style.overflow = 'hidden';
  return () => {
    if (!lock.owners.delete(owner) || lock.owners.size) return;
    body.style.overflow = lock.overflow;
    bodyScrollLocks.delete(body);
  };
}

export function HomeDialog({
  title,
  onClose,
  children,
  className,
  inactive = false,
  open = true,
  ariaLabel,
  closeLabel = 'Close',
  onBack,
  backLabel = 'Back',
  headerActions,
  surfaceRef,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  inactive?: boolean;
  /** Retain a form between openings without keeping a modal/scroll lock active. */
  open?: boolean;
  ariaLabel?: string;
  closeLabel?: string;
  onBack?(): void;
  backLabel?: string;
  headerActions?: ReactNode;
  surfaceRef?: RefObject<HTMLDialogElement | null>;
}) {
  const internalDialogRef = useRef<HTMLDialogElement>(null);
  const dialogRef = surfaceRef ?? internalDialogRef;
  const restoreFocus = useRef(document.activeElement);
  const reduced = useReducedMotion();
  const previousOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      restoreFocus.current = document.activeElement;
      return;
    }
    const dialog = dialogRef.current!;
    const focus = restoreFocus.current;
    dialog.showModal();
    const releaseScroll = lockBodyScroll();
    return () => {
      dialog.close();
      releaseScroll();
      if (focus instanceof HTMLElement && focus.isConnected) {
        let concealed = focus.closest('[inert], [hidden]');
        if (!concealed) focus.focus({ preventScroll: true });
        while (concealed) {
          const id = concealed.id;
          const trigger = id
            ? Array.from(document.querySelectorAll<HTMLElement>('[aria-controls]')).find(
                (element) =>
                  element.getAttribute('aria-controls') === id &&
                  !element.closest('[inert], [hidden]'),
              )
            : null;
          if (trigger) {
            trigger.focus({ preventScroll: true });
            break;
          }
          concealed = concealed.parentElement?.closest('[inert], [hidden]') ?? null;
        }
      }
    };
  }, [open, dialogRef]);
  // The modal is shown in the preceding effect; start its motion in that same
  // effect flush. Focus restoration stays after DOM removal, outside React's
  // mutation-time focus restoration.
  useEffect(() => {
    const opening = open && !previousOpen.current;
    previousOpen.current = open;
    if (!opening || inactive || reduced || !dialogRef.current) return;
    const animation = animateMotion(dialogRef.current, 'sheet');
    return () => animation?.cancel();
  }, [open, inactive, reduced, dialogRef]);
  return createPortal(
    <dialog
      ref={dialogRef}
      className={['home-dialog', className].filter(Boolean).join(' ')}
      aria-label={ariaLabel ?? title}
      hidden={!open}
      inert={!open || inactive || undefined}
      aria-hidden={!open || inactive || undefined}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="home-dialog-content">
        <header className={onBack ? 'home-dialog-header--back' : undefined}>
          {onBack && (
            <button type="button" className="header-action" aria-label={backLabel} onClick={onBack}>
              <UiIcon name="back" size={16} />
            </button>
          )}
          <h2>{title}</h2>
          {headerActions}
          <button type="button" className="header-action" aria-label={closeLabel} onClick={onClose}>
            <UiIcon name="close" size={16} />
          </button>
        </header>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
