import { SCROLL_NEAR_BOTTOM_PX } from './constants';

/**
 * Determine whether the scroll container should auto-scroll to the bottom.
 *
 * During active streaming, uses a larger threshold (2x viewport height) so
 * rapid tool call accumulation doesn't outpace the auto-follow. The user must
 * deliberately scroll up more than two screens to opt out.
 *
 * For finished messages, uses the fixed SCROLL_NEAR_BOTTOM_PX threshold.
 */
export function shouldAutoScroll(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  isStreaming: boolean,
): boolean {
  const distFromBottom = scrollHeight - scrollTop - clientHeight;
  const threshold = isStreaming ? clientHeight * 2 : SCROLL_NEAR_BOTTOM_PX;
  return distFromBottom <= threshold;
}
