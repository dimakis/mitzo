import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ZodError } from 'zod';
import { CollaborationApplicationReviewInputSchema } from '../src/collaboration-conversation.js';

function input() {
  return {
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      sourceConversationId: 'source',
      boundary: { sequence: 4, messageId: 'question' },
      mode: 'conversation_so_far',
      messageIds: [],
      artifacts: [],
      purpose: 'Review',
      joiningBrief: 'Edited brief',
    },
    target: {
      runOn: 'openshell',
      accountId: 'api-account',
      model: 'recording-model',
      reasoningEffort: null,
      agent: { profileId: 'published-agent', revision: 2 },
      repositoryWorkspaceId: 'prepared-workspace',
      permissionMode: 'ask',
    },
  };
}
it('accepts only setup intent and exact source references, without claiming readiness', () => {
  const request = input();
  expect(CollaborationApplicationReviewInputSchema.parse(request)).toEqual(request);
  expect(
    CollaborationApplicationReviewInputSchema.parse({
      target: { ...request.target },
      selection: { ...request.selection },
    }),
  ).toEqual(request);
  expect(
    CollaborationApplicationReviewInputSchema.parse({
      ...request,
      previousSnapshot: { snapshotId: randomUUID(), sha256: 'a'.repeat(64) },
    }).previousSnapshot,
  ).toBeDefined();
});
it.each(['settings', 'capacity', 'witness', 'operatorId', 'applicationInputSha256'])(
  'refuses caller-supplied %s authority',
  (field) => {
    expect(() =>
      CollaborationApplicationReviewInputSchema.parse({ ...input(), [field]: {} }),
    ).toThrow(ZodError);
  },
);
it.each(['permission', 'binding', 'credential', 'tools', 'maxOutputTokens'])(
  'refuses caller-supplied target %s',
  (field) => {
    const request = input();
    expect(() =>
      CollaborationApplicationReviewInputSchema.parse({
        ...request,
        target: { ...request.target, [field]: {} },
      }),
    ).toThrow(ZodError);
  },
);
it('requires explicit permission intent and a real workspace reference, while null agent conveys no default', () => {
  const request = input();
  const { permissionMode: _permissionMode, ...missingMode } = request.target;
  expect(() =>
    CollaborationApplicationReviewInputSchema.parse({ ...request, target: missingMode }),
  ).toThrow(ZodError);
  expect(() =>
    CollaborationApplicationReviewInputSchema.parse({
      ...request,
      target: { ...request.target, repositoryWorkspaceId: '' },
    }),
  ).toThrow(ZodError);
  expect(
    CollaborationApplicationReviewInputSchema.parse({
      ...request,
      target: { ...request.target, agent: null },
    }).target.agent,
  ).toBeNull();
});
