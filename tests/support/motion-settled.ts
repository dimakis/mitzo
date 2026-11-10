import { expect, type Locator } from '@playwright/test';

/** Measure resting geometry after real motion, without disabling it or rounding targets. */
export async function expectMotionSettled(control: Locator) {
  await expect
    .poll(() =>
      control.evaluate((element) => {
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          if (
            ancestor
              .getAnimations()
              .some(
                (animation) =>
                  animation.pending || ['running', 'paused'].includes(animation.playState),
              )
          )
            return false;
        }
        return true;
      }),
    )
    .toBe(true);
}
