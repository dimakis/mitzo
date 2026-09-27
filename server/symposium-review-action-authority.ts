import { randomUUID } from 'node:crypto';
import type { ReviewContext } from './symposium-review-coordinator.js';

/** Parent-held request capability. Only authenticated router composition calls bind;
 * serialized contexts and caller-supplied owner strings cannot recreate it. */
export class SymposiumReviewActionAuthority {
  private readonly requests = new WeakMap<
    ReviewContext,
    {
      owner: string;
      sessionId: string;
      action: string;
      assertCurrent(): void;
    }
  >();

  bind(context: ReviewContext, action: string, assertCurrent: () => void): () => void {
    if (this.requests.has(context)) throw new Error('Review request already authorized');
    assertCurrent();
    this.requests.set(context, {
      owner: context.owner,
      sessionId: context.sessionId,
      action,
      assertCurrent,
    });
    return () => this.requests.delete(context);
  }

  authorize(context: ReviewContext, action: string): { authorizationId: string } | null {
    const request = this.requests.get(context);
    if (
      !request ||
      request.action !== action ||
      request.owner !== context.owner ||
      request.sessionId !== context.sessionId
    )
      return null;
    this.requests.delete(context);
    try {
      request.assertCurrent();
    } catch {
      return null;
    }
    return { authorizationId: randomUUID() };
  }
}
