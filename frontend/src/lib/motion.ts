export type MotionKind = 'page' | 'fade' | 'popover' | 'sheet' | 'disclosure';

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** CSS owns all timings; absent styles or browser support mean immediate updates. */
export function animateMotion(element: HTMLElement, kind: MotionKind, opening = true) {
  if (!element.animate || window.matchMedia?.(REDUCED_MOTION_QUERY).matches) return null;
  const styles = getComputedStyle(document.documentElement);
  const token = kind === 'popover' ? 'fast' : 'standard';
  const value = styles.getPropertyValue(`--motion-duration-${token}`).trim();
  const duration = parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const easing = styles.getPropertyValue('--motion-ease').trim();
  const closed: Keyframe = { opacity: 0 };
  const opened: Keyframe = { opacity: 1 };
  // Pages use opacity only: transforms would move the containing block for fixed
  // chat controls, keyboards and portals. Content updates never call this helper.
  if (kind === 'popover' || kind === 'sheet') {
    // Individual translate composes with the tray's existing centering transform.
    closed.translate = `0 ${styles.getPropertyValue(`--motion-distance-${kind}`).trim()}`;
    opened.translate = '0 0';
  }
  if (kind === 'disclosure') {
    closed.height = '0px';
    opened.height = `${element.scrollHeight}px`;
  }
  const animation = element.animate(opening ? [closed, opened] : [opened, closed], {
    duration,
    easing,
  });
  animation.id = `mitzo:${kind}`;
  return animation;
}
