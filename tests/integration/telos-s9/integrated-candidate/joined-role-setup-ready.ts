import { expect as browserExpect, type Page, type Request, type Response } from '@playwright/test';
import { TelosWorkRoleContextReviewSchema, TelosWorkViewSchema } from '@mitzo/protocol';
import { ExplicitLocalInventorySchema } from '../../../../frontend/src/lib/explicit-local-chat';
import { expect } from 'vitest';

/** Capture requests before the real action without treating a departing
 * document's late response as the new draft's readiness. */
function observeFreshResponse(
  page: Page,
  accepts: (response: Response) => Promise<boolean>,
  acceptsRequest: (request: Request) => boolean = () => true,
) {
  const fresh = new WeakSet<Request>();
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void ready.catch(() => {});
  const onRequest = (request: Request) => {
    if (acceptsRequest(request)) fresh.add(request);
  };
  const onResponse = (response: Response) => {
    if (!fresh.has(response.request())) return;
    void accepts(response).then((accepted) => {
      if (accepted) resolve();
    }, reject);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<void>((_, no) => {
            timer = setTimeout(() => no(Error('Browser readiness response deadline')), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    close() {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  };
}

/** Chooser navigation loads the canonical item before mounting its work read.
 * Observe that exact dependency within ten seconds from before the click; DOM
 * counts retain their five-second assertions and the journey its whole-case bound.
 */
export async function actToItemChatChooser(
  page: Page,
  target: { origin: string; itemId: string; conversationId: string },
  action: () => Promise<unknown>,
) {
  const origin = new URL(target.origin).origin;
  const destinationMatches = () => {
    const destination = new URL(page.url());
    return (
      destination.origin === origin &&
      destination.pathname === `/todos/${encodeURIComponent(target.itemId)}` &&
      destination.searchParams.get('view') === 'Chat' &&
      destination.searchParams.get('chooseChat') === '1'
    );
  };
  const observer = observeFreshResponse(
    page,
    async (response) => {
      const url = new URL(response.url());
      if (
        url.origin !== origin ||
        url.pathname !== `/api/telos/work/items/${encodeURIComponent(target.itemId)}` ||
        response.request().method() !== 'GET'
      )
        return false;
      expect(response.status()).toBe(200);
      expect(await response.finished()).toBeNull();
      const work = TelosWorkViewSchema.parse(await response.json());
      expect(work.itemId).toBe(target.itemId);
      expect(
        work.links.some(
          (link) =>
            link.conversation.namespace === 'mitzo' &&
            link.conversation.conversationId === target.conversationId,
        ),
      ).toBe(true);
      return true;
    },
    destinationMatches,
  );
  await performObservedAction(observer, action, true);
  const destination = new URL(page.url());
  expect(destination.origin).toBe(origin);
  expect(destination.pathname).toBe(`/todos/${encodeURIComponent(target.itemId)}`);
  expect(destination.searchParams.get('view')).toBe('Chat');
  expect(destination.searchParams.get('chooseChat')).toBe('1');
}
async function performObservedAction(
  observer: ReturnType<typeof observeFreshResponse>,
  action: () => Promise<unknown>,
  includeActionInDeadline: boolean,
) {
  const waiting = includeActionInDeadline ? observer.wait() : undefined;
  void waiting?.catch(() => {});
  try {
    await action();
    await (waiting ?? observer.wait());
  } finally {
    observer.close();
  }
}

/** A fresh role draft may have no valid runtime settings yet. Its actual
 * inventory read proves the new composer mounted before existing five-second
 * setup-region assertions and settings interactions begin. */
export async function actToRoleSetupDraft(
  page: Page,
  origin: string,
  action: () => Promise<unknown>,
) {
  const expectedOrigin = new URL(origin).origin;
  const observer = observeFreshResponse(page, async (response) => {
    const url = new URL(response.url());
    if (
      url.origin !== expectedOrigin ||
      url.pathname !== '/api/chat/runtime/capabilities' ||
      url.searchParams.get('workspaceDefaults') !== '1' ||
      url.searchParams.has('sessionId') ||
      response.request().method() !== 'GET'
    )
      return false;
    expect(response.status()).toBe(200);
    expect(await response.finished()).toBeNull();
    ExplicitLocalInventorySchema.parse(await response.json());
    return true;
  });
  await performObservedAction(observer, action, true);
}

/** Arm before the actual chooser click, then perform the original settings
 * action. Review requires those settings: its unchanged ten-second completion
 * phase begins after configuration, while early exact reviews remain captured.
 * Every original UI interaction retains its own deadline. */
export async function actToReviewedRoleSetup(
  page: Page,
  target: { origin: string; itemId: string; role: string },
  action: () => Promise<unknown>,
  includeActionInDeadline = false,
) {
  const origin = new URL(target.origin).origin;
  const observer = observeFreshResponse(page, async (response) => {
    const url = new URL(response.url());
    const request = response.request();
    if (
      url.origin !== origin ||
      url.pathname !== '/api/telos/work/roles/review' ||
      request.method() !== 'POST'
    )
      return false;
    const input = request.postDataJSON() as { itemId?: string; role?: string };
    if (input.itemId !== target.itemId || input.role !== target.role) return false;
    expect(response.status()).toBe(200);
    expect(await response.finished()).toBeNull();
    const review = TelosWorkRoleContextReviewSchema.parse(await response.json());
    expect(review.selection.itemId).toBe(target.itemId);
    expect(review.selection.role).toBe(target.role);
    return true;
  });
  await performObservedAction(observer, action, includeActionInDeadline);
}

export async function navigateToReviewedRoleSetup(page: Page, destination: string) {
  const url = new URL(destination);
  const itemId = url.searchParams.get('telosRoleItem');
  const role = url.searchParams.get('telosRole');
  if (!itemId || !role) throw Error('Role setup navigation requires an exact item and role');
  // Existing seeded-settings navigation retains its original deadline including goto.
  await actToReviewedRoleSetup(
    page,
    { origin: url.origin, itemId, role },
    () => page.goto(destination),
    true,
  );
  await browserExpect(
    page.getByRole('region', { name: 'Work conversation setup', exact: true }),
  ).toBeVisible();
}
