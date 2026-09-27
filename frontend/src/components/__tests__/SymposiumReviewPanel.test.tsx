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
    await screen.findByText(/Automated review is not available for this workspace yet/),
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
  expect(await screen.findByText(/Automated review is not available/)).toBeTruthy();
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

it('shows a durable scoped record reference without claiming a PR was created', async () => {
  const { symposiumReviewPreviewResponses } =
    await import('../../preview/symposium-review-fixtures');
  const workflow = { ...symposiumReviewPreviewResponses.findings.workflows[0], status: 'verified' };
  const recordId = `review-${'c'.repeat(64)}`;
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    response(
      init?.method === 'POST'
        ? {
            kind: 'verified',
            publication: 'not_created',
            record: { recordId, contentHash: 'c'.repeat(64), snapshot: { historySequence: 5 } },
          }
        : { available: true, workflows: [workflow] },
    ),
  );
  render(<SymposiumReviewPanel sessionId="session" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare PR review record' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open saved review record' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/sessions/session/symposium/reviews/records/${recordId}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  expect(
    screen.getByRole('link', { name: 'Permanent saved review link' }).getAttribute('href'),
  ).toBe(`/sessions/session/review-records/${recordId}?hash=${'c'.repeat(64)}`);
  expect(screen.getByText(/No PR has been created/)).toBeTruthy();
});

it('shows only explicitly reported severity and leaves legacy findings unlabeled', async () => {
  const { symposiumReviewPreviewResponses } =
    await import('../../preview/symposium-review-fixtures');
  const workflow = symposiumReviewPreviewResponses.findings.workflows[0];
  vi.mocked(apiFetch).mockResolvedValue(
    response({
      available: false,
      workflows: [
        {
          ...workflow,
          findings: [
            { ...workflow.findings[0], severity: 'high' },
            {
              ...workflow.findings[0],
              fingerprint: 'legacy',
              summary: 'Legacy finding',
              severity: undefined,
            },
          ],
        },
      ],
    }),
  );
  render(<SymposiumReviewPanel sessionId="session" />);
  expect(await screen.findByText('Severity: high')).toBeTruthy();
  expect(screen.getAllByText(/Severity:/)).toHaveLength(1);
  expect(screen.getByText(/Legacy finding/)).toBeTruthy();
  expect(screen.getByText(/Saved review history remains readable/)).toBeTruthy();
});

it('selects earlier workflows and starts a separate review for the current artifact after a stopped review', async () => {
  const { symposiumReviewPreviewResponses } =
    await import('../../preview/symposium-review-fixtures');
  const fixture = symposiumReviewPreviewResponses.findings.workflows[0];
  const old = { ...fixture, workflowId: 'old', status: 'verified', artifactRevision: 'old-commit' };
  const stopped = { ...fixture, workflowId: 'stopped', status: 'decision_required' };
  const created = { ...fixture, workflowId: 'new', status: 'awaiting_review' };
  let workflows = [old, stopped];
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (init?.method === 'POST') {
      workflows = [...workflows, created];
      return response(created);
    }
    return response({ available: true, workflows });
  });
  render(<SymposiumReviewPanel sessionId="session" />);
  const picker = await screen.findByLabelText('Review workflow');
  fireEvent.change(picker, { target: { value: 'old' } });
  expect(screen.getByText('verified · old-commit')).toBeTruthy();
  fireEvent.change(picker, { target: { value: 'stopped' } });
  fireEvent.click(screen.getByRole('button', { name: 'New review for current artifact' }));
  fireEvent.change(screen.getByLabelText('Acceptance criteria (one per line)'), {
    target: { value: 'Fresh criteria' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/sessions/session/symposium/reviews',
      expect.objectContaining({ method: 'POST' }),
    ),
  );
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  const body = JSON.parse(call[1]!.body as string);
  expect(body.acceptanceCriteria).toEqual(['Fresh criteria']);
  expect(body).not.toHaveProperty('expectedArtifactRevision');
  expect(((await screen.findByLabelText('Review workflow')) as HTMLSelectElement).value).toBe(
    'new',
  );
  expect(screen.getByRole('option', { name: /old-commit/ })).toBeTruthy();
});

it('reloads ordered persisted decisions including reason, evidence and verification', async () => {
  const { symposiumReviewPreviewResponses } =
    await import('../../preview/symposium-review-fixtures');
  const workflow = symposiumReviewPreviewResponses.findings.workflows[0];
  const history = [
    {
      sequence: 2,
      action: 'finding_dismissed',
      detail: { actor: 'user', reason: 'Covered by caller', evidenceRefs: ['caller.ts:8'] },
    },
    {
      sequence: 1,
      action: 'fix_authorized',
      detail: { actor: 'user', reason: 'Correct the error branch' },
    },
    {
      sequence: 3,
      action: 'evidence_recorded',
      detail: {
        source: 'host',
        item: { criterion: 'Reconnect works', verdict: 'verified', evidenceRefs: ['check:42'] },
      },
    },
  ];
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    response(
      String(path).endsWith('/preview-review')
        ? { workflow, history }
        : { available: false, workflows: [workflow] },
    ),
  );
  const mounted = render(<SymposiumReviewPanel sessionId="session" />);
  fireEvent.click(await screen.findByText('Review history'));
  expect(await screen.findByText('Correct the error branch')).toBeTruthy();
  expect(screen.getByText('Covered by caller')).toBeTruthy();
  expect(screen.getByText('caller.ts:8')).toBeTruthy();
  expect(screen.getByText('Reconnect works: verified')).toBeTruthy();
  expect(screen.getByText('check:42')).toBeTruthy();
  const events = screen.getAllByTestId('review-history-event');
  expect(events[0].textContent).toContain('fix authorized');
  mounted.unmount();
  render(<SymposiumReviewPanel sessionId="session" />);
  fireEvent.click(await screen.findByText('Review history'));
  expect(await screen.findByText('Covered by caller')).toBeTruthy();
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).endsWith('/preview-review')),
  ).toHaveLength(2);
});

it('starts a new workflow despite a stranded older reservation without settling or retrying it', async () => {
  const { symposiumReviewPreviewResponses } =
    await import('../../preview/symposium-review-fixtures');
  const base = symposiumReviewPreviewResponses.findings.workflows[0];
  const stale = {
    ...base,
    workflowId: 'stale',
    status: 'awaiting_review',
    artifactRevision: 'old-artifact',
    reservations: [{ attemptId: 'old-attempt', kind: 'review', settled: false }],
  };
  const current = {
    ...base,
    workflowId: 'current',
    status: 'awaiting_review',
    artifactRevision: 'new-artifact',
  };
  let workflows = [stale];
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (init?.method === 'POST') {
      workflows = [stale, current];
      return response(current);
    }
    return response({ available: true, workflows });
  });
  render(<SymposiumReviewPanel sessionId="session" />);
  const create = await screen.findByRole('button', { name: 'New review for current artifact' });
  expect((create as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(create);
  fireEvent.change(screen.getByLabelText('Acceptance criteria (one per line)'), {
    target: { value: 'Review new artifact' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
  await waitFor(() =>
    expect((screen.getByLabelText('Review workflow') as HTMLSelectElement).value).toBe('current'),
  );
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([, init]) => init?.method === 'POST')
      .map(([path]) => path),
  ).toEqual(['/api/sessions/session/symposium/reviews']);
  fireEvent.change(screen.getByLabelText('Review workflow'), { target: { value: 'stale' } });
  expect(screen.getByText('awaiting review · old-artifact')).toBeTruthy();
  expect(stale.reservations).toEqual([
    { attemptId: 'old-attempt', kind: 'review', settled: false },
  ]);
});
