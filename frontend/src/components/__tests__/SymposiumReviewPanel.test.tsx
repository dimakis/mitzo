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

it('requires evidence and a reason to dismiss an unaccepted finding', async () => {
  const { symposiumReviewPreviewResponses } =
    await import('../../preview/symposium-review-fixtures');
  vi.mocked(apiFetch).mockResolvedValue(response(symposiumReviewPreviewResponses.findings));
  render(<SymposiumReviewPanel sessionId="session" />);
  const dismiss = await screen.findByRole('button', { name: 'Dismiss finding' });
  expect((dismiss as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Reason for accepted fixes'), {
    target: { value: 'Already verified' },
  });
  fireEvent.change(screen.getByLabelText('Evidence references for dismissal'), {
    target: { value: 'check:caller' },
  });
  fireEvent.click(dismiss);
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/sessions/session/symposium/reviews/preview-review/actions',
      expect.objectContaining({
        body: JSON.stringify({
          action: 'dismiss',
          fingerprint: 'b'.repeat(64),
          reason: 'Already verified',
          evidenceRefs: ['check:caller'],
          expectedArtifactRevision: 'preview-commit-a12',
          expectedArtifactHash: 'a'.repeat(64),
        }),
      }),
    ),
  );
});

it('loads review history only after the user opens the chat entry', async () => {
  const { SymposiumReviewEntry } = await import('../SymposiumReviewPanel');
  vi.mocked(apiFetch).mockResolvedValue(response({ available: false, workflows: [] }));
  render(<SymposiumReviewEntry sessionId="session" />);
  expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open review findings' }));
  expect(await screen.findByText(/Native review receipts/)).toBeTruthy();
});

it('attaches only a host evidence reference before preparing the current review record', async () => {
  const { symposiumReviewPreviewResponses } =
    await import('../../preview/symposium-review-fixtures');
  vi.mocked(apiFetch).mockResolvedValue(
    response({
      ...symposiumReviewPreviewResponses.findings,
      workflows: [
        { ...symposiumReviewPreviewResponses.findings.workflows[0], status: 'awaiting_evidence' },
      ],
    }),
  );
  render(<SymposiumReviewPanel sessionId="session" />);
  const attach = await screen.findByRole('button', { name: 'Attach verification' });
  expect((attach as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Host verification reference'), {
    target: { value: 'test-run-42' },
  });
  fireEvent.click(attach);
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/actions'),
      expect.objectContaining({ body: expect.stringContaining('"evidenceId":"test-run-42"') }),
    ),
  );
});
