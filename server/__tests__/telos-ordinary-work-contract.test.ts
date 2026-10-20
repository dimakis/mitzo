import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TelosWorkRoleSetupInputSchema, TelosWorkDelegationInputSchema } from '@mitzo/protocol';
import * as protocol from '@mitzo/protocol';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const f = createTelosCanonicalData();
  cleanup.push(() => f.close());
  const { work, actor, artifacts } = f;
  work.execute(
    {
      operation: 'classify',
      kind: 'outcome',
      itemId: 'studio',
      requestId: 'kind',
      expectedRevision: work.read('studio', actor).revision,
    },
    actor,
  );
  const context = reviewTelosWorkRoleContext({
    work,
    artifacts,
    actor,
    itemId: 'studio',
    role: 'lead',
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [],
  });
  const settings = {
    version: 2,
    binding: {
      version: 2,
      account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'local', targetRevision: 't1' },
    },
    selection: {
      version: 1,
      agent: { profileId: 'ordinary-worker', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
      model: 'fixture-model',
      thinking: 'low',
    },
    workspace: { kind: 'ordinary', preparationId: randomUUID() },
  };
  const input = {
    version: 2,
    itemId: 'studio',
    requestId: randomUUID(),
    expectedRevision: context.brief.revision,
    role: 'lead',
    expectedAssignmentRevision: 0,
    settings,
    contextSelection: context,
  };
  return Object.assign(f, { context, settings, input });
}
it('uses a valid V2 ordinary selection and actual canonical fields before admission', () => {
  const f = fixture();
  expect(protocol.OrdinaryWorkspaceSettingsSchema.parse(f.settings)).toEqual(f.settings);
  expect(
    f.db.prepare("SELECT first_seen,last_seen,profile FROM items WHERE id='studio'").get(),
  ).toMatchObject({ first_seen: f.stamp, last_seen: f.stamp, profile: 'manual' });
});
it('accepts an explicit ordinary V2 request while the strict V1 schemas reject it and fake repository fields', () => {
  const f = fixture();
  expect(protocol.TelosOrdinaryWorkRoleSetupInputSchema.safeParse(f.input).success).toBe(true);
  expect(TelosWorkRoleSetupInputSchema.safeParse(f.input).success).toBe(false);
  expect(
    protocol.TelosOrdinaryWorkRoleSetupInputSchema.safeParse({
      ...f.input,
      settings: { ...f.settings, repositoryWorkspaceId: 'fake' },
    }).success,
  ).toBe(false);
  const delegation = {
    version: 2,
    requestId: randomUUID(),
    leadItemId: 'studio',
    childItemId: 'slice',
    leadConversationId: 'lead',
    expectedRevision: f.context.brief.revision,
    mode: 'start',
    predecessorAttemptId: null,
    settings: f.settings,
    contextSelection: { ...f.context, itemId: 'slice', role: 'worker', leadConversationId: 'lead' },
  };
  expect(protocol.TelosOrdinaryWorkDelegationInputSchema.safeParse(delegation).success).toBe(true);
  expect(TelosWorkDelegationInputSchema.safeParse(delegation).success).toBe(false);
});
it('uses the existing role journal for V2 and recovers its exact operation after canonical owner restart', () => {
  const f = fixture();
  const first = f.work.prepareOrdinaryRoleSetup(f.input, f.actor);
  expect(first.receipt).toBeNull();
  expect(first.setup.input).toEqual(f.input);
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get()).toEqual({ n: 1 });
  f.restartOwners();
  expect(f.work.prepareOrdinaryRoleSetup(f.input, f.actor)).toEqual(first);
  expect(() =>
    f.work.prepareOrdinaryRoleSetup(
      {
        ...f.input,
        settings: { ...f.settings, workspace: { kind: 'ordinary', preparationId: randomUUID() } },
      },
      f.actor,
    ),
  ).toThrow();
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get()).toEqual({ n: 1 });
  expect(f.events.listSessions()).toHaveLength(1);
});
it('retains definite V2 pre-allocation stale-review proof without a role intent or session allocation', () => {
  const f = fixture();
  const changed = { ...f.input, expectedRevision: 'f'.repeat(64) };
  let error: unknown;
  try {
    f.work.prepareOrdinaryRoleSetup(changed, f.actor);
  } catch (e) {
    error = e;
  }
  expect(error).toMatchObject({
    recovery: { version: 1, requestId: changed.requestId, outcome: 'rejected_before_allocation' },
  });
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setups').get()).toEqual({ n: 0 });
  expect(f.db.prepare('SELECT count(*) AS n FROM telos_work_role_setup_rejections').get()).toEqual({
    n: 1,
  });
  expect(f.events.listSessions()).toHaveLength(1);
});
