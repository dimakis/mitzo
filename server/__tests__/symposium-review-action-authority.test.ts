import { describe, expect, it } from 'vitest';
import { SymposiumReviewActionAuthority } from '../symposium-review-action-authority.js';

describe('request scoped review authorization', () => {
  it('accepts exactly one matching action on the original authenticated context', () => {
    const authority = new SymposiumReviewActionAuthority();
    const context = { owner: 'user', sessionId: 'session' };
    const release = authority.bind(context, 'continue', () => undefined);
    expect(authority.authorize({ ...context }, 'continue')).toBeNull();
    expect(authority.authorize(context, 'fix')).toBeNull();
    expect(authority.authorize(context, 'continue')).toEqual({
      authorizationId: expect.any(String),
    });
    expect(authority.authorize(context, 'continue')).toBeNull();
    release();
  });
  it('rechecks expiration and revocation after asynchronous work and retires closed requests', () => {
    const authority = new SymposiumReviewActionAuthority();
    const context = { owner: 'user', sessionId: 'session' };
    let current = true;
    const release = authority.bind(context, 'fix', () => {
      if (!current) throw Error('revoked');
    });
    current = false;
    expect(authority.authorize(context, 'fix')).toBeNull();
    current = true;
    release();
    expect(authority.authorize(context, 'fix')).toBeNull();
  });
  it('does not let a mutated context retarget authenticated authorization', () => {
    const authority = new SymposiumReviewActionAuthority();
    const context = { owner: 'user', sessionId: 'session' };
    authority.bind(context, 'fix', () => undefined);
    context.sessionId = 'other';
    expect(authority.authorize(context, 'fix')).toBeNull();
  });
});
