/** Display-only fixtures. No host, provider, sandbox, credentials, or PR creation. */
const workflow = {
  workflowId: 'preview-review',
  status: 'awaiting_fix',
  artifactRevision: 'preview-commit-a12',
  artifactHash: 'a'.repeat(64),
  reviewRounds: 1,
  tokensUsed: 1420,
  costUsd: 0,
  findings: [
    {
      fingerprint: 'b'.repeat(64),
      summary: 'Preserve the selected connection after reconnect',
      location: 'frontend/src/session.ts:42',
      criterion: 'Account selection survives reconnect',
      evidenceRefs: ['mock-diff:42', 'mock-test:reconnect'],
      status: 'open',
    },
  ],
  reviews: [
    { reviewId: 'preview-full-review', kind: 'full', artifactRevision: 'preview-commit-a12' },
  ],
  reservations: [],
};
export const symposiumReviewPreviewResponses = {
  unavailable: { available: false, workflows: [] },
  findings: { available: true, workflows: [workflow] },
  delta: {
    available: true,
    workflows: [
      {
        ...workflow,
        status: 'awaiting_delta_review',
        artifactRevision: 'preview-commit-b34',
        artifactHash: 'c'.repeat(64),
      },
    ],
  },
};
