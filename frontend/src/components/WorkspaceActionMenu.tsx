import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ComponentProps } from 'react';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { UiIcon } from './UiIcon';
import '../styles/session-library.css';
export interface WorkspaceMenuItem {
  id: string;
  label: string;
  onSelect(): void;
  icon?: ComponentProps<typeof UiIcon>['name'];
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
}
/** Shared quiet action treatment and motion; no session identity is needed. */
export function WorkspaceActionMenu({
  label,
  items,
  disabled = false,
}: {
  label: string;
  items: WorkspaceMenuItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const { ref, present } = useMotionPresence(open, 'popover', false);
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    const gutter =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-gutter')) || 0;
    menu.current.style.left = `${Math.max(gutter, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - gutter))}px`;
    menu.current.style.top = `${Math.max(gutter, Math.min(anchor.bottom, window.innerHeight - bounds.height - gutter))}px`;
  }, [open, items]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      trigger.current?.focus({ preventScroll: true });
    };
  }, [open, close]);
  return (
    <>
      <button
        type="button"
        className="session-action-trigger"
        ref={trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <UiIcon name="more" />
      </button>
      {present &&
        createPortal(
          <div
            id={id}
            ref={(element) => {
              menu.current = element;
              ref.current = element;
            }}
            role="menu"
            aria-label={label}
            className="session-context-menu"
            hidden={!present}
            inert={!open}
            aria-hidden={!open || undefined}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'Tab') {
                if (event.key === 'Escape') event.preventDefault();
                event.stopPropagation();
                close();
                return;
              }
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role^="menuitem"]:not(:disabled)',
                ),
              ];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                      buttons.length
              ]?.focus();
            }}
          >
            <div className="session-actions">
              {items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={item.checked}
                  disabled={item.disabled}
                  className={item.danger ? 'session-preview-delete' : undefined}
                  onClick={() => {
                    close();
                    trigger.current?.focus({ preventScroll: true });
                    item.onSelect();
                  }}
                >
                  {(item.icon || item.checked) && (
                    <UiIcon name={item.checked ? 'check' : item.icon!} />
                  )}
                  {item.label}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
