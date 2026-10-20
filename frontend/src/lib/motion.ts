export type MotionKind = 'page' | 'fade' | 'popover' | 'sheet' | 'disclosure';

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Capture an interrupted animation before cancelling its effect. */
export function motionFrame(element: HTMLElement, kind: MotionKind): Keyframe {
  const styles = getComputedStyle(element);
  const frame: Keyframe = { opacity: styles.opacity };
  if (kind === 'popover' || kind === 'sheet') frame.translate = styles.translate;
  if (kind === 'disclosure') frame.height = `${element.getBoundingClientRect().height}px`;
  return frame;
}

/** CSS owns all timings; absent styles or browser support mean immediate updates. */
export function animateMotion(
  element: HTMLElement,
  kind: MotionKind,
  opening = true,
  from?: Keyframe,
) {
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
    // Animate the CSS-constrained border box, not overflowing scroll contents.
    // Constraints belong to the resting layout; applying them to intermediate
    // frames would clamp the entrance/exit into a plateau followed by a jump.
    opened.height = `${element.getBoundingClientRect().height}px`;
    closed.minHeight = opened.minHeight = '0px';
    closed.maxHeight = opened.maxHeight = 'none';
  }
  const animation = element.animate(
    [
      from
        ? { ...from, ...(kind === 'disclosure' ? { minHeight: '0px', maxHeight: 'none' } : {}) }
        : opening
          ? closed
          : opened,
      opening ? opened : closed,
    ],
    {
      duration,
      easing,
      // React may hide retained content on a later frame. Hold exits until that
      // commit. Hold disclosure entrances until the same release cancels their
      // temporary constraints, so natural sizing resumes without an extra frame.
      fill: opening ? (kind === 'disclosure' ? 'both' : 'none') : 'forwards',
    },
  );
  animation.id = `mitzo:${kind}`;
  if (kind === 'disclosure' && opening) trackDisclosureSize(element, animation, opened);
  return animation;
}

/** Content/budget updates retarget the remaining entrance, never replay it. */
function trackDisclosureSize(element: HTMLElement, animation: Animation, endpoint: Keyframe) {
  const effect = animation.effect as KeyframeEffect | null;
  if (!effect?.getKeyframes || !effect.setKeyframes || !effect.updateTiming) return;
  let targetHeight = Number.parseFloat(String(endpoint.height));
  const retarget = () => {
    if (!element.isConnected || !['running', 'paused'].includes(animation.playState)) return;
    const current = motionFrame(element, 'disclosure');
    const frames = effect.getKeyframes();
    // Read the actual resting CSS layout synchronously, without cancelling or
    // restarting the animation/timeline. Restore scroll positions that a larger
    // temporary scrollport could clamp while the effect is absent.
    const scrollPositions = [element, ...element.querySelectorAll<HTMLElement>('*')]
      .filter((node) => node.scrollTop || node.scrollLeft)
      .map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollTop || parent.scrollLeft)
        scrollPositions.push({ node: parent, top: parent.scrollTop, left: parent.scrollLeft });
    }
    let height: number;
    try {
      effect.setKeyframes([]);
      height = element.getBoundingClientRect().height;
    } finally {
      effect.setKeyframes(frames);
      scrollPositions.forEach(({ node, top, left }) => {
        node.scrollTop = top;
        node.scrollLeft = left;
      });
    }
    if (Math.abs(height - targetHeight) < 0.5) return;
    const duration = effect.getTiming().duration;
    const elapsed = animation.currentTime;
    if (typeof duration !== 'number' || typeof elapsed !== 'number' || elapsed >= duration) return;
    targetHeight = height;
    effect.setKeyframes([
      { ...current, minHeight: '0px', maxHeight: 'none' },
      { ...endpoint, height: `${height}px` },
    ]);
    effect.updateTiming({ duration: duration - Math.max(0, elapsed) });
    animation.currentTime = 0;
  };
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(retarget);
  resize?.observe(element);
  if (element.parentElement) resize?.observe(element.parentElement);
  for (const child of element.children) resize?.observe(child);
  const mutations = new MutationObserver(retarget);
  mutations.observe(element, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden'],
  });
  window.addEventListener('resize', retarget);
  window.visualViewport?.addEventListener('resize', retarget);
  const release = () => {
    resize?.disconnect();
    mutations.disconnect();
    window.removeEventListener('resize', retarget);
    window.visualViewport?.removeEventListener('resize', retarget);
    animation.removeEventListener?.('cancel', release);
  };
  animation.addEventListener?.('cancel', release);
  void animation.finished.then(release, release);
}

/** Shared decorative timings remain in the same theme contract. */
export function motionDuration(role: 'liquid' | 'quote' | 'handoff'): number {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--motion-duration-${role}`)
    .trim();
  const duration = parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/** A decorative shared-element flight never retains or disables the destination. */
export function animateQuoteHandoff(source: HTMLElement, target: HTMLElement, origin?: DOMRect) {
  if (!source.animate || window.matchMedia?.(REDUCED_MOTION_QUERY).matches) return null;
  const duration = motionDuration('handoff');
  if (!duration) return null;
  const from = origin ?? source.getBoundingClientRect(),
    to = target.getBoundingClientRect();
  const clone = source.cloneNode(true) as HTMLElement;
  clone.className = 'startup-quote-flight';
  clone.setAttribute('aria-hidden', 'true');
  Object.assign(clone.style, {
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
  });
  document.body.append(clone);
  const animation = clone.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      {
        transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / Math.max(1, from.width)})`,
        opacity: 0,
      },
    ],
    {
      duration,
      easing: getComputedStyle(document.documentElement).getPropertyValue('--motion-ease').trim(),
    },
  );
  void animation.finished.catch(() => {}).finally(() => clone.remove());
  return () => {
    animation.cancel();
    clone.remove();
  };
}

/** Collapse the formed wordmark into the quotation mark already laid out by the page. */
export function animateLogoToQuote(source: HTMLElement, target: HTMLElement) {
  if (!source.animate || window.matchMedia?.(REDUCED_MOTION_QUERY).matches) return null;
  const duration = motionDuration('handoff');
  if (!duration) return null;
  const from = source.getBoundingClientRect(),
    to = target.getBoundingClientRect();
  const dx = to.left + to.width / 2 - from.left - from.width / 2;
  const dy = to.top + to.height / 2 - from.top - from.height / 2;
  const animation = source.animate(
    [
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
      {
        transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${to.width / Math.max(1, from.width)})`,
        opacity: 0,
      },
    ],
    {
      duration,
      easing: getComputedStyle(document.documentElement).getPropertyValue('--motion-ease').trim(),
    },
  );
  return () => animation.cancel();
}
