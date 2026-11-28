import { afterAll, expect, it, vi } from 'vitest';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import {
  specialistAuthorizationFixture,
  specialistArtifact,
} from './fixtures/specialist-authorization.js';
const journey = createApplicationJourney();
afterAll(() => journey.close());
const authorizationFixture = (role?: string) => specialistAuthorizationFixture(journey, role);
it.each(['message', 'artifact'] as const)(
  'counts an oversized selected %s before workspace acquisition',
  async (kind) => {
    const { service, authority, input, approve, h } = await authorizationFixture();
    const policy = await service.authorize(authority, input, approve);
    const requestId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const artifacts = kind === 'artifact' ? [specialistArtifact(h.events, '界'.repeat(9000))] : [];
    if (kind === 'message')
      h.events.append('existing-chat', 'user_message', { messageId, text: '界'.repeat(11000) });
    const reserve = vi.spyOn(service.receipts, 'reserve');
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    const preview = vi.spyOn(getRepositoryWorkspaces(true), 'preview');
    try {
      const failure = await service
        .consult(authority, policy.policyId, {
          requestId,
          role: input.routes[0].role,
          assignment: 'Review the exact selected evidence.',
          messageIds: kind === 'message' ? [messageId] : [],
          artifacts,
        })
        .then(
          () => {
            throw Error('Expected preflight refusal');
          },
          (error: unknown) => error,
        );
      const { SpecialistContextLimitError } = await import('../specialist-context-envelope.js');
      expect(failure).toBeInstanceOf(SpecialistContextLimitError);
      const refused = failure as InstanceType<typeof SpecialistContextLimitError>;
      expect(refused.outcome).toBe('not_started');
      expect(
        refused.report.components[kind === 'message' ? 'messages' : 'artifacts'],
      ).toBeGreaterThan(32000);
      expect(Object.values(refused.report.components).reduce((sum, n) => sum + n, 0)).toBe(
        refused.report.totalBytes,
      );
      expect(reserve).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
      expect(service.receipts.find(authority.leadSessionId, requestId)).toBeUndefined();
    } finally {
      reserve.mockRestore();
      preview.mockRestore();
    }
  },
  30000,
);
it('preflights the complete long reviewOf contribution without allocating or dispatching a reviewer', async () => {
  const { service, authority, input, approve, h } = await authorizationFixture('large-plan');
  const reviewer = await authorizationFixture('large-review');
  const policy = await service.authorize(
    authority,
    { ...input, routes: [...input.routes, ...reviewer.input.routes] },
    approve,
  );
  const { recordApplicationMessagingRuntime } =
    await import('./fixtures/symposium-recording-runtime.js');
  const answer = 'Long attributed evidence 界🙂\n'.repeat(1200);
  const native = await recordApplicationMessagingRuntime(h.events, { answerText: answer });
  try {
    const first = { requestId: crypto.randomUUID(), role: 'large-plan', assignment: 'Plan.' };
    await service.consult(authority, policy.policyId, first);
    await vi.waitFor(
      () => expect(service.read(authority, first.requestId).status).toBe('completed'),
      { timeout: 5000 },
    );
    const planned = service.read(authority, first.requestId);
    expect(planned.contributions[0].text).toBe(answer);
    const requestId = crypto.randomUUID();
    const reserve = vi.spyOn(service.receipts, 'reserve');
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    const preview = vi.spyOn(getRepositoryWorkspaces(true), 'preview');
    try {
      await expect(
        service.consult(authority, policy.policyId, {
          requestId,
          role: 'large-review',
          assignment: 'Review independently.',
          reviewOf: first.requestId,
        }),
      ).rejects.toMatchObject({
        code: 'context_limit',
        outcome: 'not_started',
        report: { components: { reviewContribution: expect.any(Number) } },
      });
      expect(reserve).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
      expect(service.receipts.find(authority.leadSessionId, requestId)).toBeUndefined();
      expect(native.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
      expect(service.read(authority, first.requestId).contributions).toEqual(planned.contributions);
    } finally {
      reserve.mockRestore();
      preview.mockRestore();
    }
  } finally {
    const { registry } = await import('../chat.js');
    for (const entry of registry.entries(true)) registry.abort(entry[0]);
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle(), { timeout: 5000 });
    native.restore();
  }
}, 30000);
