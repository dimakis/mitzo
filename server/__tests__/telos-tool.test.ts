import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeTelosCreateOutcome,
  telosCreateOutcomeDefinition,
  TELOS_CREATE_OUTCOME_TOOL,
  formatTelosSourceResult,
} from '../telos-tool.js';

const input = {
  summary: 'Persist sandbox outcomes in live Telos',
  intent: 'Sandboxed agents create durable outcomes through the Mitzo host.',
  rationale: 'Local sandbox writes disappear and currently look successful.',
  acceptanceCriteria: ['The outcome is visible in the live Telos UI'],
  milestones: ['Expose the trusted host tool'],
  profile: 'manual',
};
const approvalId = '00000000-0000-4000-8000-000000000001';
const approvedInput = { ...input, __mitzoTelosApproval: approvalId };
const sourceReceipt = {
  canonicalCreation: {
    ok: true as const,
    created: true,
    item: { id: 'telos-1', summary: input.summary },
  },
  permId: 'permission',
  sessionId: 'planning',
  sourceSnapshotId: 'source',
  operation: { kind: 'create', outcome: input },
  receipt: {
    commandId: 'command',
    actorId: 'operator:user',
    work: {
      itemId: 'telos-1',
      kind: 'outcome',
      parentId: null,
      revision: 'a'.repeat(64),
      links: [],
      assignments: [],
      sources: [],
      attempts: [],
    },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('Telos host tool', () => {
  it('preserves a real recovered created:false receipt and its delivery metadata instead of inferring creation', () => {
    const canonicalCreation = {
      ok: true as const,
      created: false,
      item: { id: 'telos-1', summary: input.summary },
      delivery: { state: 'retained' },
      recovery: { request: 'original' },
    };
    const result = formatTelosSourceResult({
      ...sourceReceipt,
      operation: { kind: 'create', outcome: input },
      canonicalCreation,
    });
    const body = JSON.parse(result.content);
    expect(body.created).toBe(false);
    expect(body.canonicalCreation).toEqual(canonicalCreation);
  });
  it('refuses an execution without a host-injected reviewed source receipt before contacting the host', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await executeTelosCreateOutcome('http://host', 'client', 'token', input)).isError).toBe(
      true,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('advertises live host delivery instead of sandbox-local scripts', () => {
    expect(telosCreateOutcomeDefinition.name).toBe(TELOS_CREATE_OUTCOME_TOOL);
    expect(telosCreateOutcomeDefinition.description).toContain('live Telos');
    expect(telosCreateOutcomeDefinition.description).toContain('sandbox-local');
  });

  it('sends the approved outcome through the authenticated host endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(sourceReceipt), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);

    const result = await executeTelosCreateOutcome(
      'http://localhost:3100',
      'client-1',
      'secret',
      approvedInput,
    );

    expect(result).toEqual({
      content: JSON.stringify({
        created: true,
        canonicalCreation: sourceReceipt.canonicalCreation,
        id: 'telos-1',
        title: input.summary,
        path: '/todos/telos-1',
        sourceSnapshotId: 'source',
      }),
      isError: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3100/api/internal/telos/source/execute',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Internal-Token': 'secret',
          'X-Client-Id': 'client-1',
        }),
        body: JSON.stringify({
          approvalReceiptId: approvalId,
          proposal: input,
          operation: 'create',
        }),
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
      executeTelosCreateOutcome('http://localhost:3100', 'client-1', 'secret', approvedInput),
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
    ).resolves.toMatchObject({ content: expect.stringContaining('milestones'), isError: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ok: true },
    { ok: true, created: true, item: {} },
    { ok: true, created: true, item: { id: '', summary: 'Outcome' } },
  ])(
    'requires a confirmed creation receipt instead of treating malformed success as saved',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
      expect(
        (await executeTelosCreateOutcome('http://host', 'client', 'token', approvedInput)).isError,
      ).toBe(true);
    },
  );
});
