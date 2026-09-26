import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';

type Workflow = {
  workflowId: string;
  status: string;
  artifactRevision: string;
  artifactHash: string;
  reviewRounds: number;
  tokensUsed: number;
  costUsd: number;
  findings: Array<{
    fingerprint: string;
    summary: string;
    location: string;
    criterion: string;
    evidenceRefs: string[];
    status: string;
  }>;
  reviews: Array<{ reviewId: string; kind: string; artifactRevision: string }>;
  reservations: Array<{ attemptId: string; kind: 'review' | 'fix'; settled: boolean }>;
};
export function SymposiumReviewPanel({ sessionId }: { sessionId: string }) {
  return <ReviewPanel key={sessionId} sessionId={sessionId} />;
}
function ReviewPanel({ sessionId }: { sessionId: string }) {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/symposium/reviews`;
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [available, setAvailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [criteria, setCriteria] = useState('');
  const [tokens, setTokens] = useState(10000);
  const [rounds, setRounds] = useState(2);
  const [record, setRecord] = useState('');
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const response = await apiFetch(base, { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Cannot load review');
      if (signal?.aborted) return;
      setAvailable(data.available);
      setWorkflows(data.workflows);
      setLoaded(true);
    },
    [base],
  );
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setError(String(error));
    });
    return () => controller.abort();
  }, [reload]);
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError('');
    setRecord('');
    try {
      const response = await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          workflow
            ? {
                ...(body as Record<string, unknown>),
                expectedArtifactRevision: workflow.artifactRevision,
                expectedArtifactHash: workflow.artifactHash,
              }
            : body,
        ),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || result.code || 'Review action failed');
      if (result.publication === 'not_created') setRecord(JSON.stringify(result, null, 2));
      setSelected([]);
      setReason('');
      await reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Review action failed');
    } finally {
      setBusy(false);
    }
  }
  const workflow = workflows.at(-1);
  const pending = workflow?.reservations.find((attempt) => !attempt.settled);
  const endpoint = workflow ? `${base}/${encodeURIComponent(workflow.workflowId)}/actions` : base;
  return (
    <section
      aria-label="Review findings"
      className="space-y-3 rounded-lg border border-gray-700 p-4 text-sm"
    >
      <h3 className="font-semibold">Review findings</h3>
      {error && <p role="alert">{error}</p>}
      {!loaded && !error && <p>Loading review history…</p>}
      {loaded && !available && (
        <p>
          Native review receipts and enforced budgets are not available. Review and fix execution
          remain disabled until the trusted runtime is connected.
        </p>
      )}
      {workflow && (
        <>
          <p>
            {workflow.status.replaceAll('_', ' ')} · {workflow.artifactRevision}
          </p>
          <p>
            {workflow.reviewRounds} review rounds · {workflow.tokensUsed} tokens · $
            {workflow.costUsd.toFixed(2)} recorded
          </p>
          <ul className="space-y-2">
            {workflow.findings.map((finding) => (
              <li key={finding.fingerprint} className="rounded border border-gray-700 p-2">
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Accept: ${finding.summary}`}
                    disabled={busy || !available || finding.status !== 'open'}
                    checked={selected.includes(finding.fingerprint)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, finding.fingerprint]
                          : current.filter((id) => id !== finding.fingerprint),
                      )
                    }
                  />
                  <span>
                    {finding.summary} ({finding.status})
                  </span>
                </label>
                <p>
                  {finding.location} · {finding.criterion}
                </p>
                <p>Evidence: {finding.evidenceRefs.join(', ')}</p>
              </li>
            ))}
          </ul>
          {workflow.status === 'awaiting_fix' && (
            <>
              <label className="block">
                Reason for accepted fixes
                <input
                  className="block w-full rounded border p-2"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button
                disabled={
                  busy || !available || !selected.length || !reason.trim() || Boolean(pending)
                }
                onClick={() =>
                  void action(endpoint, {
                    action: 'fix',
                    findingFingerprints: selected,
                    reason: reason.trim(),
                  })
                }
              >
                Accept selected findings and fix
              </button>
              <p>Every open finding needs an explicit decision before the builder can run.</p>
            </>
          )}
          {['awaiting_review', 'awaiting_delta_review'].includes(workflow.status) && (
            <button
              disabled={busy || !available || Boolean(pending)}
              onClick={() => void action(endpoint, { action: 'review' })}
            >
              {workflow.status === 'awaiting_delta_review'
                ? 'Review changed artifact'
                : 'Run review'}
            </button>
          )}
          {pending && (
            <button
              disabled={busy || !available}
              onClick={() =>
                void action(endpoint, {
                  action: 'recover',
                  attemptId: pending.attemptId,
                  kind: pending.kind,
                })
              }
            >
              Recover completed attempt
            </button>
          )}
          {['awaiting_evidence', 'verified'].includes(workflow.status) && (
            <button
              disabled={busy || !available}
              onClick={() => void action(endpoint, { action: 'review-record' })}
            >
              Prepare PR review record
            </button>
          )}
          <details>
            <summary>Review history</summary>
            <ul>
              {workflow.reviews.map((review) => (
                <li key={review.reviewId}>
                  {review.kind} review · {review.artifactRevision} · {review.reviewId}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {loaded && available && !workflow && (
        <>
          <label className="block">
            Acceptance criteria (one per line)
            <textarea
              className="block w-full rounded border p-2"
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
            />
          </label>
          <label className="block">
            Token budget
            <input
              type="number"
              min="1"
              value={tokens}
              onChange={(event) => setTokens(Number(event.target.value))}
            />
          </label>
          <label className="block">
            Maximum review rounds
            <input
              type="number"
              min="1"
              value={rounds}
              onChange={(event) => setRounds(Number(event.target.value))}
            />
          </label>
          <button
            disabled={busy || !criteria.trim() || tokens < 1 || rounds < 1}
            onClick={() =>
              void action(base, {
                workflowId: crypto.randomUUID(),
                acceptanceCriteria: criteria
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
                limits: { maxTokens: tokens, maxReviewRounds: rounds, maxCostUsd: null },
              })
            }
          >
            Start review
          </button>
        </>
      )}
      {record && (
        <label className="block">
          Current revision review record
          <textarea className="block h-64 w-full" readOnly value={record} />
          <span>Copy this record into an explicitly created PR. No PR has been created.</span>
        </label>
      )}
      <button
        disabled={busy}
        onClick={() => void reload().catch((error) => setError(String(error)))}
      >
        Refresh review
      </button>
    </section>
  );
}
