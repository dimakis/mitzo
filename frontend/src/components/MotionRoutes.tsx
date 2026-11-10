import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { animateMotion } from '../lib/motion';
import { useReducedMotion } from '../hooks/useReducedMotion';

/** Stable boundary: never key routes or keep old pages/subscriptions mounted for motion. */
export function MotionRoutes({ children }: { children: ReactNode }) {
  const { pathname, state } = useLocation();
  const previous = useRef(pathname);
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const changed = previous.current !== pathname;
    // First-command acknowledgement names the surface already on screen. It
    // must not hide the submitted message behind another navigation fade.
    const assignedChat =
      previous.current === '/chat' &&
      /^\/chat\/[^/]+$/.test(pathname) &&
      state?.chatAssignment === true;
    previous.current = pathname;
    if (!changed || assignedChat || reduced || !ref.current) return;
    const root = ref.current;
    let animation: Animation | null = null;
    const start = () => {
      const surface =
        root.querySelector<HTMLElement>('.desktop-center') ??
        root.querySelector<HTMLElement>('.mobile-workspace-body') ??
        (root.firstElementChild as HTMLElement | null);
      if (!surface || surface.classList.contains('auth-status')) return;
      animation = animateMotion(surface, 'page');
      observer.disconnect();
    };
    // Authentication can settle after navigation. Animate the page once it exists,
    // then disconnect so streaming messages and loading results do not replay it.
    const observer = new MutationObserver(start);
    observer.observe(root, { childList: true, subtree: true });
    start();
    return () => {
      observer.disconnect();
      animation?.cancel();
    };
  }, [pathname, state, reduced]);
  return (
    <div className="motion-routes" ref={ref}>
      {children}
    </div>
  );
}
