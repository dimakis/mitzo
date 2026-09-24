import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeTelosCreateOutcome,
  telosCreateOutcomeDefinition,
  TELOS_CREATE_OUTCOME_TOOL,
} from '../telos-tool.js';

const input = {
  summary: 'Persist sandbox outcomes in live Telos',
  intent: 'Sandboxed agents create durable outcomes through the Mitzo host.',
  rationale: 'Local sandbox writes disappear and currently look successful.',
  acceptanceCriteria: ['The outcome is visible in the live Telos UI'],
  milestones: ['Expose the trusted host tool'],
  profile: 'manual',
};

afterEach(() => vi.unstubAllGlobals());

describe('Telos host tool', () => {
  it('advertises live host delivery instead of sandbox-local scripts', () => {
    expect(telosCreateOutcomeDefinition.name).toBe(TELOS_CREATE_OUTCOME_TOOL);
    expect(telosCreateOutcomeDefinition.description).toContain('live Telos');
    expect(telosCreateOutcomeDefinition.description).toContain('sandbox-local');
  });

  it('sends the approved outcome through the authenticated host endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          created: true,
          item: { id: 'telos-1', summary: input.summary },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetch);

    const result = await executeTelosCreateOutcome(
      'http://localhost:3100',
      'client-1',
      'secret',
      input,
    );

    expect(result).toEqual({
      content: JSON.stringify({
        created: true,
        id: 'telos-1',
        title: input.summary,
        path: '/todos/telos-1',
      }),
      isError: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3100/api/internal/telos/outcomes',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Internal-Token': 'secret',
          'X-Client-Id': 'client-1',
        }),
        body: JSON.stringify(input),
      }),
    );
  });

  it('fails closed when live Telos rejects the write', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'Todo service unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(
      executeTelosCreateOutcome('http://localhost:3100', 'client-1', 'secret', input),
    ).resolves.toEqual({ content: 'Todo service unavailable', isError: true });
  });

  it('rejects malformed input before contacting the host', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      executeTelosCreateOutcome('http://localhost:3100', 'client-1', 'secret', {
        ...input,
        milestones: [],
      }),
    ).resolves.toEqual({ content: 'Invalid Telos outcome input', isError: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});
