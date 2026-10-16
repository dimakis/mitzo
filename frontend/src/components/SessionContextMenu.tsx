import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '../types/chat';
import type { SessionActionPoint } from '../hooks/useSessionInteraction';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { SessionActions, type SessionActionsProps } from './SessionActions';
import '../styles/session-library.css';
export interface SessionMenuState {
  session: Session;
  trigger: HTMLElement;
  point?: SessionActionPoint;
}
export function SessionContextMenu({
  state,
  onClose,
  onOpen,
  onRename,
  onDelete,
  onDetails,
}: {
  state: SessionMenuState | null;
  onClose: () => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDetails?: () => void;
}) {
  const retained = useRef(state);
  if (state) retained.current = state;
  const { ref, present } = useMotionPresence(!!state, 'popover', false);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!state || !menuRef.current) return;
    const element = menuRef.current;
    const bounds = state.trigger.getBoundingClientRect();
    const x = state.point?.x ?? bounds.right;
    const y = state.point?.y ?? bounds.bottom;
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - element.offsetHeight - 8))}px`;
  }, [state]);
  useEffect(() => {
    if (!state) return;
    const element = menuRef.current;
    element?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element?.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', onClose);
      if (state.trigger.isConnected && !state.trigger.closest('[inert], [hidden]'))
        state.trigger.focus({ preventScroll: true });
    };
  }, [state, onClose]);
  const selected = state ?? retained.current;
  if (!present || !selected) return null;
  const props: SessionActionsProps = {
    session: selected.session,
    onOpen,
    onRename,
    onDelete,
    onClose,
    onDetails,
    menu: true,
  };
  return createPortal(
    <div
      ref={(element) => {
        menuRef.current = element;
        ref.current = element;
      }}
      role="menu"
      aria-label="Session actions"
      className="session-context-menu"
      hidden={!present}
      inert={!state}
      aria-hidden={!state || undefined}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)',
          ),
        ];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
      }}
    >
      <SessionActions key={selected.session.id} {...props} />
    </div>,
    document.body,
  );
}
