import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AccountBinding } from '@mitzo/protocol';
import {
  resolveOrdinaryContributorGuidance,
  saveOrdinaryContributorGuidance,
} from '../ordinary-contributor-guidance.js';

const binding: AccountBinding = {
  accountId: 'personal',
  accountLabel: 'Personal',
  provider: 'openai-codex',
  model: 'offline-luna',
  profileRevision: 'v1',
};
function store() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    getSessionEvents: () => events,
    append: (_id: string, type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
      return events.length;
    },
  };
}
it('retains exact contributor guidance for child UI resumes while ordinary sessions keep their default', () => {
  const owner = store();
  expect(resolveOrdinaryContributorGuidance(owner, 'ordinary', binding)).toBeUndefined();
  saveOrdinaryContributorGuidance(owner, 'child', binding, 'Selected guidance.');
  expect(resolveOrdinaryContributorGuidance(owner, 'child', binding)).toBe('Selected guidance.');
  saveOrdinaryContributorGuidance(owner, 'child', binding, 'Selected guidance.');
  expect(owner.events).toHaveLength(1);
});
it('rejects changed account scopes, corrupt snapshots and attempted guide replacement', () => {
  const owner = store();
  saveOrdinaryContributorGuidance(owner, 'child', binding, 'Selected guidance.');
  expect(() =>
    resolveOrdinaryContributorGuidance(owner, 'child', { ...binding, accountId: 'other' }),
  ).toThrow();
  expect(() =>
    resolveOrdinaryContributorGuidance(owner, 'child', binding, 'Replacement.'),
  ).toThrow();
  owner.events[0].payload.guidance = 'Changed bytes.';
  expect(() => resolveOrdinaryContributorGuidance(owner, 'child', binding)).toThrow();
});
it('requires an explicit bound account for trusted guidance and limits stored bytes', () => {
  expect(() => saveOrdinaryContributorGuidance(store(), 'child', undefined, 'Guide.')).toThrow();
  expect(() =>
    saveOrdinaryContributorGuidance(store(), 'child', binding, 'x'.repeat(100_001)),
  ).toThrow();
  expect(() =>
    resolveOrdinaryContributorGuidance(
      {
        getSessionEvents: () => [
          {
            type: 'contributor_guidance',
            payload: {
              version: 1,
              guidance: 'Guide.',
              guidanceHash: createHash('sha256').update('Guide.').digest('hex'),
            },
          },
        ],
      },
      'child',
      binding,
    ),
  ).toThrow();
});
