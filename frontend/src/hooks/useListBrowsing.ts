import { useEffect, useState, type RefObject } from 'react';

/** Keep list positions still until a full second after browsing has stopped. */
export function useListBrowsing(ref: RefObject<HTMLElement | null>, blocked: boolean): boolean {
  const [browsing, setBrowsing] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pointers = new Set<number>();
    let touching = false,
      keyboard = false;
    const focused = () =>
      element.contains(document.activeElement) &&
      (keyboard || document.activeElement?.matches('input, textarea, [contenteditable="true"]'));
    const hold = () => {
      clearTimeout(timer);
      setBrowsing(true);
    };
    const release = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!pointers.size && !touching && !focused()) setBrowsing(false);
      }, 1000);
    };
    const browse = () => {
      hold();
      release();
    };
    const down = (event: PointerEvent) => {
      keyboard = false;
      pointers.add(event.pointerId);
      hold();
    };
    const up = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      release();
    };
    const touchStart = () => {
      touching = true;
      keyboard = false;
      hold();
    };
    const touchEnd = () => {
      touching = false;
      release();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab') keyboard = true;
      if (element.contains(document.activeElement)) {
        keyboard = true;
        browse();
      }
    };
    const focus = () => {
      if (focused()) hold();
      else release();
    };
    const blur = () => {
      pointers.clear();
      touching = false;
      keyboard = false;
      release();
    };
    element.addEventListener('scroll', browse, { passive: true });
    element.addEventListener('wheel', browse, { passive: true });
    element.addEventListener('pointerdown', down);
    element.addEventListener('touchstart', touchStart, { passive: true });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('touchend', touchEnd);
    document.addEventListener('touchcancel', touchEnd);
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', release);
    window.addEventListener('blur', blur);
    return () => {
      clearTimeout(timer);
      element.removeEventListener('scroll', browse);
      element.removeEventListener('wheel', browse);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('touchstart', touchStart);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('touchend', touchEnd);
      document.removeEventListener('touchcancel', touchEnd);
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', release);
      window.removeEventListener('blur', blur);
    };
  }, [ref]);
  return blocked || browsing;
}
