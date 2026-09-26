// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumReviewPanel } from '../SymposiumReviewPanel';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
it('explains unavailable native receipts without offering an unsafe workflow launch', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ available: false, workflows: [] }));
  render(<SymposiumReviewPanel sessionId="session" />);
  expect(
    await screen.findByText(/Native review receipts and enforced budgets are not available/),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull();
});
it('requires explicit finding selection and reason before requesting a fix', async () => {
  const workflow = {
    workflowId: 'flow',
    status: 'awaiting_fix',
    artifactRevision: 'commit',
    artifactHash: 'a'.repeat(64),
    reviewRounds: 1,
    tokensUsed: 40,
    costUsd: 0,
    findings: [
      {
        fingerprint: 'fingerprint',
        summary: 'Fix branch',
        location: 'app.ts:4',
        criterion: 'works',
        evidenceRefs: ['diff:4'],
        status: 'open',
      },
    ],
    reservations: [],
    reviews: [],
  };
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    response(init?.method === 'POST' ? workflow : { available: true, workflows: [workflow] }),
  );
  render(<SymposiumReviewPanel sessionId="session" />);
  const accept = await screen.findByRole('button', { name: 'Accept selected findings and fix' });
  expect((accept as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Accept: Fix branch'));
  fireEvent.change(screen.getByLabelText('Reason for accepted fixes'), {
    target: { value: 'Required for correctness' },
  });
  fireEvent.click(accept);
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/sessions/session/symposium/reviews/flow/actions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'fix',
          findingFingerprints: ['fingerprint'],
          reason: 'Required for correctness',
          expectedArtifactRevision: 'commit',
          expectedArtifactHash: 'a'.repeat(64),
        }),
      }),
    ),
  );
});
