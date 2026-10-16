import { useRef, type MouseEvent, type TouchEvent, type KeyboardEvent } from 'react';
import { useLongPress } from './useLongPress';
export type SessionActionPoint = { x: number; y: number };
export type SessionActionTrigger = (trigger: HTMLElement, point?: SessionActionPoint) => void;

export function useSessionInteraction(onOpen: () => void, onActions: SessionActionTrigger) {
  const trigger = useRef<HTMLElement | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const moved = useRef(false);
  const hold = useLongPress(() => {
    if (trigger.current) onActions(trigger.current);
  });
  return {
    onTouchStart(event: TouchEvent<HTMLElement>) {
      if (event.touches.length !== 1) {
        hold.cancel();
        return;
      }
      trigger.current = event.currentTarget;
      moved.current = false;
      start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      hold.start();
    },
    onTouchMove(event: TouchEvent<HTMLElement>) {
      const touch = event.touches[0];
      if (
        !touch ||
        Math.hypot(touch.clientX - start.current.x, touch.clientY - start.current.y) > 10
      ) {
        moved.current = true;
        hold.cancel();
      }
    },
    onTouchEnd() {
      hold.cancel();
    },
    onTouchCancel() {
      moved.current = true;
      hold.cancel();
    },
    onClick(event: MouseEvent<HTMLElement>) {
      const held = hold.consumeClick();
      if (held || moved.current) {
        moved.current = false;
        event.preventDefault();
        return;
      }
      onOpen();
    },
    onContextMenu(event: MouseEvent<HTMLElement>) {
      event.preventDefault();
      hold.cancel();
      onActions(event.currentTarget, { x: event.clientX, y: event.clientY });
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        onActions(event.currentTarget);
      }
    },
  };
}
