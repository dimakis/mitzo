import { useLayoutEffect, useRef, useState } from 'react';
import { animateMotion, type MotionKind } from '../lib/motion';
import { useReducedMotion } from './useReducedMotion';

/** Retain exits for their animation only. Callers immediately hide them from input and AT. */
export function useMotionPresence(open: boolean, kind: MotionKind, appear = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [retained, setRetained] = useState(open);
  const initial = useRef(true);
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const first = initial.current;
    initial.current = false;
    if (open) setRetained(true);
    const root = ref.current;
    if (!root || reduced || (first && !appear)) {
      if (!open) setRetained(false);
      return;
    }
    const surface =
      kind === 'disclosure' ? root : ((root.firstElementChild as HTMLElement) ?? root);
    const dialog = surface.querySelector<HTMLElement>('[role="dialog"]');
    const animations = [animateMotion(surface, dialog ? 'page' : kind, open)];
    if (dialog) animations.push(animateMotion(dialog, kind, open));
    const active = animations.filter((animation) => animation !== null);
    if (!active.length) {
      if (!open) setRetained(false);
      return;
    }
    root.dataset.motionActive = 'true';
    let disposed = false;
    void Promise.all(active.map((animation) => animation.finished))
      .then(() => {
        if (disposed) return;
        delete root.dataset.motionActive;
        if (!open) setRetained(false);
      })
      .catch(() => {
        /* Cancellation is expected when interrupted or unmounted. */
      });
    return () => {
      disposed = true;
      delete root.dataset.motionActive;
      active.forEach((animation) => animation.cancel());
    };
  }, [open, kind, appear, reduced]);

  return { ref, present: open || retained };
}
