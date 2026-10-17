import { describe, expect, it } from 'vitest';
import { TelosOutcomeCreateBodySchema, TelosOutcomeProposalSchema } from '@mitzo/protocol';
import { TodoOutcomeCreateBody } from '../api-schemas.js';
import { readFileSync } from 'node:fs';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

const proposal = {
  summary: ' Studio ',
  intent: 'Record music',
  rationale: 'Why',
  acceptanceCriteria: ['Reviewed'],
  milestones: ['Plan acoustics'],
  profile: 'personal',
  contextHints: { repos: ['studio'], sessionIds: ['recorded-origin'] },
  links: [{ type: 'design', url: 'docs/plan.md', title: 'Plan' }],
};
describe('one canonical outcome creation wire contract', () => {
  it('pins the shared canonical schema and the existing API owner', () => {
    const manifest: Record<string, string> = reviewedHandlerSourceArtifacts;
    for (const file of [
      '../../packages/protocol/src/telos-outcome.ts',
      '../api-schemas.ts',
      '../../packages/protocol/src/index.ts',
    ])
      expect(manifest[file], file).toBe(
        reviewedHandlerSourceFingerprint(
          readFileSync(new URL(file, new URL('../connections/', import.meta.url)), 'utf8'),
        ),
      );
  });
  it('shares the existing Telos API contract without dropping context, links or legacy defaults', () => {
    const input = { ...proposal, idempotencyKey: 'explicit' };
    expect(TelosOutcomeCreateBodySchema.parse(input)).toEqual(TodoOutcomeCreateBody.parse(input));
    expect(TelosOutcomeProposalSchema.parse(proposal)).toEqual({
      ...TodoOutcomeCreateBody.parse(input),
      idempotencyKey: undefined,
    });
  });
  it('keeps creation identity host-owned for reviewed proposals and retains canonical limits', () => {
    expect(
      TelosOutcomeProposalSchema.safeParse({ ...proposal, idempotencyKey: 'caller' }).success,
    ).toBe(false);
    expect(TelosOutcomeProposalSchema.safeParse({ ...proposal, actor: 'caller' }).success).toBe(
      false,
    );
    expect(TelosOutcomeProposalSchema.safeParse({ ...proposal, intent: '' }).success).toBe(false);
    expect(
      TelosOutcomeProposalSchema.safeParse({
        ...proposal,
        milestones: Array.from({ length: 25 }, () => 'Too many'),
      }).success,
    ).toBe(false);
  });
});
