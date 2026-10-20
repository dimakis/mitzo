import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { animateMotion, motionFrame, type MotionKind } from '../lib/motion';
import { useReducedMotion } from './useReducedMotion';

/** Retain exits for their animation only. Disable motion when a surface becomes inline.
 * Callers immediately hide closing surfaces from input and assistive technology. */
export function useMotionPresence(
  open: boolean,
  kind: MotionKind,
  appear = true,
  enabled = true,
  surfaceRef?: RefObject<HTMLDivElement | null>,
) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = surfaceRef ?? localRef;
  const [retained, setRetained] = useState(open);
  const initial = useRef(true);
  const previousOpen = useRef(open);
  const changed = useRef(false);
  const reduced = useReducedMotion();
  const interrupted = useRef(new Map<HTMLElement, Keyframe>());
  const releaseExit = useRef<(() => void) | null>(null);

  // Release the filled endpoint only after React has hidden/unmounted the root.
  useLayoutEffect(() => {
    if (!open && !retained) {
      releaseExit.current?.();
      releaseExit.current = null;
    }
  }, [open, retained]);

  useLayoutEffect(() => {
    const pendingFrames = interrupted.current;
    const first = initial.current;
    initial.current = false;
    changed.current ||= previousOpen.current !== open;
    previousOpen.current = open;
    if (open) setRetained(true);
    const root = ref.current;
    if (
      !root ||
      !enabled ||
      reduced ||
      (!changed.current && !appear) ||
      (first && !open) ||
      (!open && root.hidden)
    ) {
      pendingFrames.clear();
      if (!open) setRetained(false);
      return;
    }
    const surface =
      kind === 'disclosure' || !root.classList.contains('motion-presence')
        ? root
        : ((root.firstElementChild as HTMLElement) ?? root);
    const dialog = surface.querySelector<HTMLElement>('[role="dialog"]');
    const targets: { element: HTMLElement; kind: MotionKind }[] = [
      { element: surface, kind: dialog ? 'page' : kind },
    ];
    if (dialog) targets.push({ element: dialog, kind });
    const active = targets.flatMap((target) => {
      const animation = animateMotion(
        target.element,
        target.kind,
        open,
        pendingFrames.get(target.element),
      );
      return animation ? [{ ...target, animation }] : [];
    });
    pendingFrames.clear();
    if (!active.length) {
      if (!open) setRetained(false);
      return;
    }
    root.dataset.motionActive = 'true';
    let disposed = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      delete root.dataset.motionActive;
      active.forEach(({ animation }) => animation.cancel());
    };
    releaseExit.current = release;
    void Promise.all(active.map(({ animation }) => animation.finished))
      .then(() => {
        if (disposed) return;
        if (!open) setRetained(false);
        else release();
      })
      .catch(() => {
        /* Cancellation is expected when interrupted or unmounted. */
      });
    return () => {
      disposed = true;
      if (!released && root.isConnected && !root.hidden) {
        active.forEach(({ element, kind, animation }) => {
          if (animation.playState !== 'idle')
            pendingFrames.set(element, motionFrame(element, kind));
        });
      }
      release();
      releaseExit.current = null;
    };
  }, [open, kind, appear, reduced, enabled, ref]);

  return { ref, present: open || retained };
}
