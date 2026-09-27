import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import type { ReactNode } from 'react';
const render = (node: ReactNode) =>
  baseRender(<MitzoStoreProvider value={createTestStore()}>{node}</MitzoStoreProvider>);
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as baseRender, screen, waitFor } from '@testing-library/react';
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
  fireEvent.change(screen.getByLabelText('Maximum host turns'), { target: { value: '1000' } });
  fireEvent.change(screen.getByLabelText('Maximum review/fix cycles'), { target: { value: '2' } });
  chooseDeadlineAndProgress();
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
  fireEvent.click(screen.getByRole('button', { name: 'New review for current artifact' }));
  expect((screen.getByLabelText('Maximum host turns') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Maximum review/fix cycles') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Deadline') as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('button', { name: 'Start review' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
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
  fireEvent.change(screen.getByLabelText('Maximum host turns'), { target: { value: '1000' } });
  fireEvent.change(screen.getByLabelText('Maximum review/fix cycles'), { target: { value: '2' } });
  chooseDeadlineAndProgress();
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

const deadline = '2099-01-01T12:00';
function chooseDeadlineAndProgress() {
  fireEvent.change(screen.getByLabelText('Deadline'), { target: { value: deadline } });
  fireEvent.change(screen.getByLabelText('Maximum unchanged cycles'), { target: { value: '2' } });
}
function chooseLimits() {
  fireEvent.change(screen.getByLabelText('Maximum host turns'), { target: { value: '12' } });
  fireEvent.change(screen.getByLabelText('Maximum review/fix cycles'), { target: { value: '2' } });
  chooseDeadlineAndProgress();
}
const policy = {
  version: 1,
  mode: 'application',
  maxHostTurns: 12,
  maxReviewCycles: 2,
  deadlineAt: new Date(deadline).getTime(),
  noProgressLimit: 2,
};
it('requires every application limit explicitly and posts the selected policy', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ available: true, workflows: [] }));
  render(<SymposiumReviewPanel sessionId="session" />);
  const start = await screen.findByRole('button', { name: 'Start review' });
  fireEvent.change(screen.getByLabelText('Acceptance criteria (one per line)'), {
    target: { value: 'Correct behavior' },
  });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  for (const label of [
    'Maximum host turns',
    'Maximum review/fix cycles',
    'Deadline',
    'Maximum unchanged cycles',
  ])
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
  expect(screen.queryByLabelText('Token budget')).toBeNull();
  chooseLimits();
  fireEvent.change(screen.getByLabelText('Maximum host turns'), { target: { value: '1.5' } });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Maximum host turns'), { target: { value: '12' } });
  fireEvent.click(start);
  await waitFor(() =>
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
  );
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string).limits).toEqual(policy);
});
it('shows selected policy and actual counters, binds stop and explicit continuation, and keeps unknown totals honest', async () => {
  const { symposiumReviewPreviewResponses } =
    await import('../../preview/symposium-review-fixtures');
  let workflow = {
    ...symposiumReviewPreviewResponses.findings.workflows[0],
    limits: policy,
    status: 'awaiting_review',
    hostTurns: 3,
    reviewCycles: 1,
    applicationAttempts: [],
    tokensUsed: 0,
    costUsd: 0,
    usageCompleteness: { tokens: 'partial', cost: 'partial' },
    decisionCode: undefined as string | undefined,
  };
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (init?.method === 'POST') {
      workflow = { ...workflow, status: 'decision_required', decisionCode: 'user_stop' };
      return response(workflow);
    }
    return response({ available: true, workflows: [workflow] });
  });
  render(<SymposiumReviewPanel sessionId="session" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Stop review' }));
  await screen.findByText('Stopped: user_stop');
  expect(screen.getByText(/3 of 12 host turns/)).toBeTruthy();
  expect(screen.getByText(/1 of 2 review\/fix cycles/)).toBeTruthy();
  expect(screen.getByText(/Token total unknown/)).toBeTruthy();
  expect(screen.getByText(/Cost total unknown/)).toBeTruthy();
  const resume = screen.getByRole('button', { name: 'Authorize continuation' });
  expect((resume as HTMLButtonElement).disabled).toBe(true);
  chooseLimits();
  fireEvent.change(screen.getByLabelText('Reason for continuation'), {
    target: { value: 'Finish remaining review' },
  });
  fireEvent.click(resume);
  await waitFor(() =>
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(2),
  );
  const bodies = vi
    .mocked(apiFetch)
    .mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(init!.body as string));
  expect(bodies).toEqual([
    {
      action: 'stop',
      expectedArtifactRevision: workflow.artifactRevision,
      expectedArtifactHash: workflow.artifactHash,
    },
    {
      action: 'continue',
      limits: policy,
      reason: 'Finish remaining review',
      expectedArtifactRevision: workflow.artifactRevision,
      expectedArtifactHash: workflow.artifactHash,
    },
  ]);
});

it('blocks continuation for unresolved application attempts and clears choices when selecting another workflow', async () => {
  const { symposiumReviewPreviewResponses } =
    await import('../../preview/symposium-review-fixtures');
  const base = {
    ...symposiumReviewPreviewResponses.findings.workflows[0],
    limits: policy,
    status: 'decision_required',
    decisionCode: 'user_stop',
    hostTurns: 3,
    reviewCycles: 1,
  };
  const workflows = [
    { ...base, workflowId: 'old', applicationAttempts: [] },
    {
      ...base,
      workflowId: 'pending',
      applicationAttempts: [{ attemptId: 'unknown', kind: 'review', settled: false }],
    },
  ];
  vi.mocked(apiFetch).mockResolvedValue(response({ available: true, workflows }));
  render(<SymposiumReviewPanel sessionId="session" />);
  await screen.findByRole('button', { name: 'Authorize continuation' });
  chooseLimits();
  fireEvent.change(screen.getByLabelText('Reason for continuation'), {
    target: { value: 'Continue' },
  });
  expect(
    (screen.getByRole('button', { name: 'Authorize continuation' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText(/Reconcile the unresolved attempt/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Review workflow'), { target: { value: 'old' } });
  expect((screen.getByLabelText('Maximum host turns') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Reason for continuation') as HTMLInputElement).value).toBe('');
});
