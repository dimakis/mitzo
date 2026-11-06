// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TelosOutcomeNotice } from '../TelosOutcomeNotice';
afterEach(cleanup);
it('presents requested changes and cancellation as expected review outcomes', () => {
  const block = {
    blockId: 'proposal',
    blockType: 'tool_use' as const,
    content: '',
    toolName: 'TelosCreateOutcome',
  };
  const revision = {
    kind: 'telos_outcome_changes_requested',
    permId: 'permission',
    sessionId: 'conversation',
    toolUseId: 'call',
    requestId: '00000000-0000-4000-8000-000000000001',
    proposalSha256: 'a'.repeat(64),
    feedback: 'Focus on mobile.',
    originalOutcome: {
      summary: 'Create outcomes',
      intent: 'Save reliably',
      rationale: 'Retain agreed work',
      acceptanceCriteria: ['Created item is visible'],
      milestones: ['Verify mobile'],
      profile: 'manual',
    },
    nextAction:
      'Revise the original outcome using this feedback, then call TelosCreateOutcome again for fresh approval. No outcome was created.',
  };
  const view = render(
    <TelosOutcomeNotice block={{ ...block, toolResult: JSON.stringify(revision) }} />,
  );
  expect(screen.getByRole('region', { name: 'Outcome changes requested' }).textContent).toContain(
    'Focus on mobile.',
  );
  expect(screen.queryByRole('region', { name: 'Outcome creation problem' })).toBeNull();
  view.rerender(
    <TelosOutcomeNotice
      block={{
        ...block,
        toolResult: JSON.stringify({
          kind: 'telos_proposal_cancelled',
          message:
            'The operator cancelled this proposal. Do not retry or create work unless they ask again.',
        }),
      }}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe('Outcome creation cancelled.');
});
