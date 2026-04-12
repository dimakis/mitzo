import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGoal, reportUsage, deriveGoalTitle, resetAvailability } from '../goal-client.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  resetAvailability();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deriveGoalTitle', () => {
  it('returns short prompts as-is', () => {
    expect(deriveGoalTitle('Fix the login bug')).toBe('Fix the login bug');
  });

  it('truncates at first sentence boundary', () => {
    expect(deriveGoalTitle('Fix the login bug. Also update the tests and docs.')).toBe(
      'Fix the login bug.',
    );
  });

  it('truncates at trailing punctuation without space after', () => {
    expect(deriveGoalTitle('Fix the login bug.')).toBe('Fix the login bug.');
  });

  it('handles exclamation and question marks at end', () => {
    expect(deriveGoalTitle('Is this a bug?')).toBe('Is this a bug?');
    expect(deriveGoalTitle('Fix this now!')).toBe('Fix this now!');
  });

  it('truncates long single sentences to 80 chars', () => {
    const long = 'A'.repeat(100);
    const result = deriveGoalTitle(long);
    expect(result.length).toBe(80);
    expect(result.endsWith('...')).toBe(true);
  });

  it('collapses whitespace', () => {
    expect(deriveGoalTitle('  Fix   the\n  bug  ')).toBe('Fix the bug');
  });
});

describe('createGoal', () => {
  it('creates a goal when ContexGin is available', async () => {
    // Health check
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Goal creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'goal-123', title: 'Fix bug', status: 'active' }),
    });

    const goalId = await createGoal('Fix bug');
    expect(goalId).toBe('goal-123');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify the POST call
    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toContain('/api/goals');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({
      title: 'Fix bug',
      description: undefined,
      contextCondition: undefined,
    });
  });

  it('returns null when ContexGin is unavailable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const goalId = await createGoal('Fix bug');
    expect(goalId).toBeNull();
  });

  it('returns null on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true }); // health
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 }); // create

    const goalId = await createGoal('Fix bug');
    expect(goalId).toBeNull();
  });
});

describe('reportUsage', () => {
  it('posts usage contribution to goal registry', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true }); // health
    mockFetch.mockResolvedValueOnce({ ok: true }); // report

    await reportUsage('goal-123', {
      source: 'mitzo_session',
      sourceId: 'session-456',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toContain('/api/goals/goal-123/contributions');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.source).toBe('mitzo_session');
    expect(body.inputTokens).toBe(1000);
  });

  it('silently handles ContexGin being down', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    // Should not throw
    await reportUsage('goal-123', {
      source: 'mitzo_session',
      sourceId: 'session-456',
    });
  });
});

describe('network error sets available=false', () => {
  it('POST network error causes next call to skip health check and return null', async () => {
    // Health check succeeds
    mockFetch.mockResolvedValueOnce({ ok: true });
    // POST throws network error
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));

    const goalId = await createGoal('Test goal');
    expect(goalId).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2); // health + failed POST

    // Next call should skip health check entirely (cached as unavailable) and return null
    const goalId2 = await createGoal('Another goal');
    expect(goalId2).toBeNull();
    // No additional fetch calls — cached unavailability
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('health-check caching', () => {
  it('caches availability within the TTL window', async () => {
    // First call: health check succeeds
    mockFetch.mockResolvedValueOnce({ ok: true }); // health
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'goal-1', title: 'A', status: 'active' }),
    });
    await createGoal('First');
    expect(mockFetch).toHaveBeenCalledTimes(2); // health + create

    // Second call within TTL: should skip health check
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'goal-2', title: 'B', status: 'active' }),
    });
    await createGoal('Second');
    // Only 3 total: original health + first create + second create (no second health)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('re-checks availability after TTL expires', async () => {
    // First call: health check succeeds
    mockFetch.mockResolvedValueOnce({ ok: true }); // health
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'goal-1', title: 'A', status: 'active' }),
    });
    await createGoal('First');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Expire the cache by resetting
    resetAvailability();

    // Next call should re-check health
    mockFetch.mockResolvedValueOnce({ ok: true }); // health again
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'goal-2', title: 'B', status: 'active' }),
    });
    await createGoal('Third');
    expect(mockFetch).toHaveBeenCalledTimes(4); // 2 original + health + create
  });

  it('caches unavailability within the TTL window', async () => {
    // Health check fails
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result1 = await createGoal('First');
    expect(result1).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call within TTL: cached as unavailable, no fetch at all
    const result2 = await createGoal('Second');
    expect(result2).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1); // still just the original failed health check
  });
});
