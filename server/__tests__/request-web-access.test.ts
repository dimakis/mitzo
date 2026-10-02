import { describe, expect, it, vi } from 'vitest';
import { executeWebAccess, WebAccessInput } from '../request-web-access.js';

describe('account-independent web access boundary', () => {
  it('exposes search and website reads as different exact requests', () => {
    expect(
      WebAccessInput.safeParse({
        operation: 'search',
        query: 'Revenue returns',
        reason: 'Verify rules',
      }).success,
    ).toBe(true);
    expect(
      WebAccessInput.safeParse({
        operation: 'fetch',
        url: 'https://www.revenue.ie/',
        reason: 'Read official guidance',
      }).success,
    ).toBe(true);
    expect(
      WebAccessInput.safeParse({
        operation: 'search',
        query: 'q',
        url: 'https://example.com',
        reason: 'why',
      }).success,
    ).toBe(false);
  });
  it.each(['deny', 'changed', 'aborted', 'stale'] as const)(
    'never dispatches an unapproved %s request',
    async (caseName) => {
      const search = vi.fn();
      const abort = new AbortController();
      const input = { operation: 'search', query: 'Revenue', reason: 'Verify rules' };
      const result = await executeWebAccess(input, abort.signal, {
        isCurrent: () => caseName !== 'stale',
        approve: async () => {
          if (caseName === 'aborted') abort.abort();
          return caseName === 'deny'
            ? { behavior: 'deny', message: 'User declined' }
            : {
                behavior: 'allow',
                updatedInput: caseName === 'changed' ? { ...input, query: 'other' } : input,
              };
        },
        search,
        fetchPage: vi.fn(),
      });
      expect(result.isError).toBe(true);
      expect(search).not.toHaveBeenCalled();
    },
  );
  it('dispatches the approved query once and returns sources without widening the grant', async () => {
    const input = { operation: 'search', query: 'Revenue', reason: 'Verify rules' };
    const search = vi.fn().mockResolvedValue('Answer [Revenue](https://www.revenue.ie/)');
    const approve = vi.fn().mockResolvedValue({ behavior: 'allow', updatedInput: input });
    expect(
      await executeWebAccess(input, new AbortController().signal, {
        isCurrent: () => true,
        approve,
        search,
        fetchPage: vi.fn(),
      }),
    ).toEqual({ content: 'Answer [Revenue](https://www.revenue.ie/)', isError: false });
    expect(search).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  });
  it('routes website access independently of the model search backend', async () => {
    const input = { operation: 'fetch', url: 'https://www.revenue.ie/', reason: 'Read guidance' };
    const fetchPage = vi.fn().mockResolvedValue('page');
    const search = vi.fn();
    await executeWebAccess(input, new AbortController().signal, {
      isCurrent: () => true,
      approve: async () => ({ behavior: 'allow', updatedInput: input }),
      search,
      fetchPage,
    });
    expect(fetchPage).toHaveBeenCalledWith(input.url, expect.any(AbortSignal));
    expect(search).not.toHaveBeenCalled();
  });
  it('redacts provider errors and does not try another account', async () => {
    const input = { operation: 'search', query: 'Revenue', reason: 'Verify rules' };
    const search = vi.fn().mockRejectedValue(new Error('secret token'));
    const result = await executeWebAccess(input, new AbortController().signal, {
      isCurrent: () => true,
      approve: async () => ({ behavior: 'allow', updatedInput: input }),
      search,
      fetchPage: vi.fn(),
    });
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('secret');
    expect(search).toHaveBeenCalledTimes(1);
  });
});
