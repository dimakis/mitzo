import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';

export interface SurfaceInboxObservation {
  result: Promise<{ status: number; body: unknown }>;
  restore(): void;
}

/** Self-contained so Playwright can install it in the current main document. */
export function installSurfaceControlInbox({
  key,
  itemId,
  selector,
}: {
  key: string;
  itemId: string;
  selector: string;
}): void {
  const context = window;
  const original = context.fetch;
  let active = true;
  let selected = false;
  let resolve!: (value: { status: number; body: unknown }) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<{ status: number; body: unknown }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void result.catch(() => {});
  const wrapped: typeof fetch = function (this: Window, ...args) {
    let eligible = false;
    let signal: AbortSignal | null | undefined;
    try {
      const [input, init] = args;
      signal = init?.signal;
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        context.location.href,
      );
      const command = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      eligible =
        active &&
        !selected &&
        context === context.top &&
        !!context.document.querySelector(selector) &&
        url.origin === context.location.origin &&
        url.pathname === '/api/telos/work/controls' &&
        init?.method === 'POST' &&
        command?.operation === 'inbox' &&
        command.itemId === itemId;
    } catch {
      // Unrelated or unreadable requests still call the original fetch unchanged.
    }
    const cancelled = (error: unknown) =>
      signal?.aborted &&
      (error === signal.reason || (error instanceof DOMException && error.name === 'AbortError'));
    let response: Promise<Response>;
    try {
      response = Reflect.apply(original, this, args);
    } catch (error) {
      if (eligible && !cancelled(error)) {
        selected = true;
        reject(error);
      }
      throw error;
    }
    if (eligible)
      void response.then(
        (value) => {
          if (!active || selected) return;
          selected = true;
          try {
            void value
              .clone()
              .json()
              .then((body) => resolve({ status: value.status, body }), reject);
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          // StrictMode can cancel an effect before it has any HTTP response.
          // Only its own aborted signal permits another eligible live response.
          if (active && !selected && !cancelled(error)) {
            selected = true;
            reject(error);
          }
        },
      );
    // Observing a clone must not replace the application's Promise or Response.
    return response;
  };
  context.fetch = wrapped;
  (context as unknown as Record<string, SurfaceInboxObservation>)[key] = {
    result,
    restore() {
      active = false;
      if (context.fetch === wrapped) context.fetch = original;
      reject(Error('Surface inbox observation closed'));
    },
  };
}

/** Observe the first exact inbox issued by a newly mounted responsive surface. */
export async function observeSurfaceControlInbox(
  page: Page,
  itemId: string,
  selector: string,
  transition: () => Promise<unknown>,
) {
  const key = `__mitzoSurfaceInbox_${randomUUID()}`;
  await page.evaluate(installSurfaceControlInbox, { key, itemId, selector });
  const pending = page.evaluate(
    (key) => (window as unknown as Record<string, SurfaceInboxObservation>)[key].result,
    key,
  );
  void pending.catch(() => {});
  try {
    const [inbox] = await Promise.all([pending, transition()]);
    return inbox;
  } finally {
    await page
      .evaluate((key) => {
        const observations = window as unknown as Record<string, SurfaceInboxObservation>;
        observations[key].restore();
        delete observations[key];
      }, key)
      // A closed/replaced document has already discarded this test-only wrapper.
      .catch(() => {});
  }
}
