import { expect, it, vi } from 'vitest';
import { TelosWorkRoleSetupInputSchema } from '@mitzo/protocol';
import { TelosWorkApiClient, TelosWorkApiError } from '../telos-work-api.js';

const requestId = '36d873de-89ab-4f06-b8c9-38603454d079';
const revision = 'a'.repeat(64);
const input = TelosWorkRoleSetupInputSchema.parse({
  itemId: 'item',
  role: 'lead',
  requestId,
  expectedRevision: revision,
  expectedAssignmentRevision: 0,
  contextSelection: {
    version: 1,
    itemId: 'item',
    role: 'lead',
    brief: { revision, sha256: 'b'.repeat(64), text: 'Reviewed work' },
    parentCriteria: [],
    overallGoal: { itemId: 'item', revision, text: 'Goal' },
    sources: [],
    artifacts: [],
  },
  settings: {
    binding: {
      version: 2,
      account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'offline', targetRevision: 'r1' },
    },
    repositoryWorkspaceId: 'eb46159d-5ad7-4f64-90cb-6b9e7d219c64',
    selection: {
      version: 1,
      agent: { profileId: 'offline', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
      model: 'offline-fixture',
      thinking: null,
    },
  },
});

it.each(['rejected_before_allocation', 'recover_original'] as const)(
  'CT03/04: carries validated %s HTTP evidence without a hidden retry',
  async (outcome) => {
    const recovery = { version: 1, requestId, outcome };
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'conflict',
          error: 'Role setup conflict',
          recovery,
        }),
        { status: 409 },
      ),
    );
    const api = new TelosWorkApiClient(fetch);
    const error = await api.setupRole(structuredClone(input)).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TelosWorkApiError);
    expect(error).toMatchObject({ status: 409, code: 'conflict', recovery });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
  },
);

it.each([
  undefined,
  { version: 2, requestId, outcome: 'rejected_before_allocation' },
  { version: 1, requestId: 7, outcome: 'rejected_before_allocation' },
  { version: 1, requestId, outcome: 'safe_to_retry_anything' },
  { version: 1, requestId },
])('CT04: malformed/absent phase evidence cannot prove safe rejection (%j)', async (recovery) => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 'conflict',
        error: 'Work revision conflict',
        recovery,
      }),
      { status: 409 },
    ),
  );
  const error = await new TelosWorkApiClient(fetch)
    .setupRole(input)
    .catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(TelosWorkApiError);
  expect(error).not.toMatchObject({
    recovery: expect.objectContaining({ outcome: 'rejected_before_allocation' }),
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  {
    status: 409,
    code: 'conflict',
    proof: { version: 1, requestId: 'another-request', outcome: 'rejected_before_allocation' },
  },
  {
    status: 409,
    code: 'conflict',
    proof: { version: 1, requestId, outcome: 'rejected_before_allocation', unexpected: true },
  },
  {
    status: 503,
    code: 'conflict',
    proof: { version: 1, requestId, outcome: 'rejected_before_allocation' },
  },
  {
    status: 409,
    code: 'unavailable',
    proof: { version: 1, requestId, outcome: 'rejected_before_allocation' },
  },
  {
    status: 403,
    code: 'unauthorized',
    proof: { version: 1, requestId, outcome: 'rejected_before_allocation' },
  },
])(
  'CT04: contradictory or wrong-request rejection evidence stays uncertain (%j)',
  async ({ status, code, proof }) => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code, error: 'Unqualified rejection', recovery: proof }), {
        status,
      }),
    );
    const cause = await new TelosWorkApiClient(fetch)
      .setupRole(input)
      .catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(TelosWorkApiError);
    expect(cause).not.toMatchObject({
      recovery: expect.objectContaining({ outcome: 'rejected_before_allocation' }),
    });
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it('CT04: another command endpoint cannot supply role-setup rejection authority', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 'conflict',
        error: 'Another command',
        recovery: { version: 1, requestId, outcome: 'rejected_before_allocation' },
      }),
      { status: 409 },
    ),
  );
  const cause = await new TelosWorkApiClient(fetch)
    .execute({
      operation: 'classify',
      itemId: 'item',
      requestId,
      expectedRevision: revision,
      kind: 'outcome',
    })
    .catch((error: unknown) => error);
  expect(cause).toBeInstanceOf(TelosWorkApiError);
  expect(cause).not.toMatchObject({
    recovery: expect.objectContaining({ outcome: 'rejected_before_allocation' }),
  });
  expect(fetch).toHaveBeenCalledOnce();
});
