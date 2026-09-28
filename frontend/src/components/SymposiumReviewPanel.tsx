import { SymposiumPublication } from './SymposiumPublication';
import { SymposiumSavedReviewRecord } from './SymposiumSavedReviewRecord';
import { SymposiumReviewHistory } from './SymposiumReviewHistory';
import './SymposiumReviewPanel.css';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';

import type {
  InitialApplicationRun,
  ApplicationPolicy,
  CriterionCheck,
  ReviewWorkflow as Workflow,
} from '../types/symposium-review';
export function SymposiumReviewEntry({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="symposium-review-entry">
      <button aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? 'Close review findings' : 'Open review findings'}
      </button>
      {open && <SymposiumReviewPanel sessionId={sessionId} />}
    </div>
  );
}

export function SymposiumReviewPanel({ sessionId }: { sessionId: string }) {
  return <ReviewPanel key={sessionId} sessionId={sessionId} />;
}
function ReviewPanel({ sessionId }: { sessionId: string }) {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/symposium/reviews`;
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [criterionChecks, setCriterionChecks] = useState<CriterionCheck[]>([]);
  const [selectedCheck, setSelectedCheck] = useState('');
  const [confirmedArtifact, setConfirmedArtifact] = useState(false);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [newReview, setNewReview] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [available, setAvailable] = useState(false);
  const [stopAvailable, setStopAvailable] = useState(false);
  const [applicationRun, setApplicationRun] = useState<InitialApplicationRun>({
    available: false,
    initialArtifact: null,
  });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [dismissalEvidence, setDismissalEvidence] = useState('');
  const [criteria, setCriteria] = useState('');
  const [hostTurns, setHostTurns] = useState('');
  const [cycles, setCycles] = useState('');
  const [deadline, setDeadline] = useState('');
  const [noProgress, setNoProgress] = useState('');
  const [record, setRecord] = useState('');
  const [savedRecordOpen, setSavedRecordOpen] = useState(false);
  const [recordReference, setRecordReference] = useState<{ id: string; hash: string } | null>(null);
  const [evidenceId, setEvidenceId] = useState('');
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const response = await apiFetch(base, { signal });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? 'Add a reviewer to this conversation before starting an integrated review.'
            : data.error || 'Cannot load review',
        );
      if (signal?.aborted) return;
      setAvailable(data.available);
      setStopAvailable(data.stopAvailable ?? data.available);
      setApplicationRun(data.applicationRun ?? { available: false, initialArtifact: null });
      setWorkflows(data.workflows);
      if (data.workflows.some((item: Workflow) => item.limits?.mode === 'application'))
        setNewReview(false);
      setCriterionChecks(data.criterionChecks ?? []);
      setConfirmedArtifact(false);
      setHistoryVersion((version) => version + 1);
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
    setSavedRecordOpen(false);
    setRecord('');
    setRecordReference(null);
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
      if (path === `${base}/application-runs` && typeof result.workflowId === 'string') {
        setWorkflowId(result.workflowId);
        setNewReview(false);
      }
      if (result.publication === 'not_created') {
        setRecord(JSON.stringify(result.record, null, 2));
        if (
          /^review-[a-f0-9]{64}$/.test(result.record?.recordId) &&
          /^[a-f0-9]{64}$/.test(result.record?.contentHash)
        )
          setRecordReference({ id: result.record.recordId, hash: result.record.contentHash });
      }
      setSelected([]);
      setReason('');
      await reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Review action failed');
    } finally {
      setBusy(false);
    }
  }
  const hasApplicationRun = workflows.some((item) => item.limits?.mode === 'application');
  const workflow =
    newReview && !hasApplicationRun
      ? undefined
      : (workflows.find((item) => item.workflowId === workflowId) ?? workflows.at(-1));
  function resetLimits() {
    setHostTurns('');
    setCycles('');
    setDeadline('');
    setNoProgress('');
  }
  const positiveInteger = (value: string) =>
    value.trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const validLimits =
    positiveInteger(hostTurns) &&
    positiveInteger(cycles) &&
    positiveInteger(noProgress) &&
    new Date(deadline).getTime() > Date.now();
  const limits: ApplicationPolicy = {
    version: 1,
    mode: 'application',
    maxHostTurns: Number(hostTurns),
    maxReviewCycles: Number(cycles),
    deadlineAt: new Date(deadline).getTime(),
    noProgressLimit: Number(noProgress),
  };
  const application = workflow?.limits?.mode === 'application' ? workflow.limits : undefined;
  const pendingAttempt = (
    application ? workflow?.applicationAttempts : workflow?.reservations
  )?.find((attempt) => !attempt.settled);
  const pendingPreparation = application
    ? workflow?.applicationPreparations?.find((preparation) => preparation.status === 'preparing')
    : undefined;
  const settledPreparation = application
    ? workflow?.applicationPreparations
        ?.filter((preparation) => preparation.status === 'settled')
        .at(-1)
    : undefined;
  const pending = pendingPreparation ?? pendingAttempt;
  const pendingKind =
    pending && 'effectiveKind' in pending ? (pending.effectiveKind ?? pending.kind) : pending?.kind;
  const recoveryKind =
    pendingKind === 'delta' ? 'review' : pendingKind === 'retry' ? undefined : pendingKind;
  const limitFields = (
    <fieldset disabled={busy}>
      <legend>{workflow ? 'Amend application limits' : 'Application limits'}</legend>
      <label>
        Maximum host turns
        <input
          type="number"
          min="1"
          value={hostTurns}
          onChange={(event) => setHostTurns(event.target.value)}
        />
      </label>
      <label>
        Maximum review/fix cycles
        <input
          type="number"
          min="1"
          value={cycles}
          onChange={(event) => setCycles(event.target.value)}
        />
      </label>
      <label>
        Deadline
        <input
          type="datetime-local"
          value={deadline}
          onChange={(event) => setDeadline(event.target.value)}
        />
      </label>
      <label>
        Maximum unchanged cycles
        <input
          type="number"
          min="1"
          value={noProgress}
          onChange={(event) => setNoProgress(event.target.value)}
        />
      </label>
      <p>
        Limits fence new work and request cancellation. Accepted calls may still finish. Token and
        spend caps are not guaranteed.
      </p>
    </fieldset>
  );
  const endpoint = workflow ? `${base}/${encodeURIComponent(workflow.workflowId)}/actions` : base;
  return (
    <section aria-label="Review findings" className="symposium-review-panel">
      <h3>Review findings</h3>
      {error && <p role="alert">{error}</p>}
      {!loaded && !error && <p>Loading review history…</p>}
      {loaded && !available && (
        <p>
          Automated review is not available for this workspace yet. Saved review history remains
          readable. You can inspect earlier findings here or continue reviewing the changes
          manually.
        </p>
      )}
      {workflows.length > 0 && (
        <label>
          Review workflow
          <select
            value={workflow?.workflowId ?? ''}
            disabled={busy}
            onChange={(event) => {
              setWorkflowId(event.target.value);
              resetLimits();
              setNewReview(false);
              setSelected([]);
              setReason('');
              setRecord('');
              setConfirmedArtifact(false);
            }}
          >
            {newReview && !hasApplicationRun && <option value="">New run</option>}
            {workflows.map((item) => (
              <option key={item.workflowId} value={item.workflowId}>
                {item.artifactRevision} · {item.status.replaceAll('_', ' ')} · {item.workflowId}
              </option>
            ))}
          </select>
        </label>
      )}
      {loaded && available && workflows.length > 0 && !newReview && !hasApplicationRun && (
        <button
          disabled={busy}
          onClick={() => {
            setNewReview(true);
            resetLimits();
            setSelected([]);
            setReason('');
            setRecord('');
            setConfirmedArtifact(false);
          }}
        >
          New implementation and review run
        </button>
      )}
      {workflow && (
        <>
          <p>
            {workflow.status.replaceAll('_', ' ')} · {workflow.artifactRevision}
          </p>
          {application ? (
            <>
              <p>
                {workflow.hostTurns ?? 'Unknown'} of {application.maxHostTurns} host turns ·{' '}
                {workflow.reviewCycles ?? 'Unknown'} of {application.maxReviewCycles} review/fix
                cycles
              </p>
              <p>
                Deadline: {new Date(application.deadlineAt).toLocaleString()} · Maximum unchanged
                cycles: {application.noProgressLimit}
              </p>
              <p>Application limits; no guaranteed token or spend cap.</p>
              {!workflow.decisionCode && (
                <button
                  disabled={busy || !stopAvailable}
                  onClick={() => void action(endpoint, { action: 'stop' })}
                >
                  Stop review
                </button>
              )}
            </>
          ) : (
            <p>
              {workflow.reviewRounds} review rounds · Historical review record; no current cap
              enforcement claimed.
            </p>
          )}
          <p>
            {workflow.usageCompleteness?.tokens === 'complete' && workflow.tokensUsed != null
              ? `${workflow.tokensUsed} tokens recorded`
              : 'Token total unknown'}{' '}
            ·{' '}
            {workflow.usageCompleteness?.cost === 'complete' && workflow.costUsd != null
              ? `$${workflow.costUsd.toFixed(2)} recorded`
              : 'Cost total unknown'}
          </p>
          {workflow.decisionCode && <p>Stopped: {workflow.decisionCode}</p>}
          {workflow.decisionCode && settledPreparation?.disposition && (
            <p>
              Preparation {settledPreparation.attemptId} reconciled:{' '}
              {settledPreparation.disposition === 'applied_no_dispatch'
                ? 'transition applied; no native dispatch'
                : 'transition not applied; no native dispatch'}
            </p>
          )}
          {application && workflow.decisionCode && (
            <>
              {limitFields}
              <label>
                Reason for continuation
                <input value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
              <p>
                Authorize amended cumulative limits for this workflow. Earlier attempts remain
                counted.
              </p>
              <button
                disabled={
                  busy ||
                  !available ||
                  Boolean(pending) ||
                  !validLimits ||
                  !reason.trim() ||
                  limits.maxHostTurns <= (workflow.hostTurns ?? 0) ||
                  limits.maxReviewCycles < (workflow.reviewCycles ?? 0)
                }
                onClick={() =>
                  void action(endpoint, { action: 'continue', limits, reason: reason.trim() })
                }
              >
                Authorize continuation
              </button>
              {pending && <p>Reconcile the unresolved attempt before continuing.</p>}
            </>
          )}
          <ul>
            {workflow.findings.map((finding) => (
              <li key={finding.fingerprint}>
                <label>
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
                {finding.severity && (
                  <p className="symposium-review-severity">Severity: {finding.severity}</p>
                )}
                <p>
                  {finding.location} · {finding.criterion}
                </p>
                <p>Evidence: {finding.evidenceRefs.join(', ')}</p>
                {finding.status === 'open' && (
                  <button
                    disabled={
                      busy ||
                      !available ||
                      Boolean(pending) ||
                      !reason.trim() ||
                      !dismissalEvidence.trim()
                    }
                    onClick={() =>
                      void action(endpoint, {
                        action: 'dismiss',
                        fingerprint: finding.fingerprint,
                        reason: reason.trim(),
                        evidenceRefs: dismissalEvidence
                          .split('\n')
                          .map((ref) => ref.trim())
                          .filter(Boolean),
                      })
                    }
                  >
                    Dismiss finding
                  </button>
                )}
              </li>
            ))}
          </ul>
          {workflow.acceptanceCriteria && workflow.acceptanceCriteria.length > 0 && (
            <section aria-label="Criterion verification">
              <h4>Criterion verification</h4>
              <p>
                Current result: {workflow.currentResultId ?? 'none'} · Artifact:{' '}
                {workflow.artifactRevision} · SHA-256: {workflow.artifactHash}
              </p>
              {workflow.status === 'awaiting_evidence' && criterionChecks.length > 0 && (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmedArtifact}
                    disabled={busy || !available || Boolean(pending)}
                    onChange={(event) => setConfirmedArtifact(event.target.checked)}
                  />
                  Confirm exact artifact for criterion checks: {workflow.artifactRevision} ·
                  SHA-256: {workflow.artifactHash}
                </label>
              )}
              <ul>
                {workflow.acceptanceCriteria.map((criterion) => {
                  const current = workflow.evidence
                    ?.filter(
                      (entry) =>
                        entry.source === 'host' &&
                        entry.item.criterion === criterion &&
                        entry.item.resultId === workflow.currentResultId &&
                        entry.item.artifactRevision === workflow.artifactRevision &&
                        entry.artifactHash === workflow.artifactHash,
                    )
                    .at(-1);
                  const verdict = current?.item.verdict ?? 'missing evidence';
                  const registered = criterionChecks.find((item) => item.criterion === criterion);
                  return (
                    <li key={criterion}>
                      <span>
                        {criterion}: {verdict}
                      </span>
                      {workflow.status === 'awaiting_evidence' && registered && (
                        <button
                          disabled={busy || !available || Boolean(pending) || !confirmedArtifact}
                          onClick={() =>
                            void action(endpoint, { action: 'check', definitionId: registered.id })
                          }
                        >
                          Run registered check: {criterion}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {workflow.acceptanceCriteria.some(
                (criterion) => !criterionChecks.some((check) => check.criterion === criterion),
              ) && (
                <p>
                  Unregistered criteria need separate trusted host evidence. A reviewer's assertion
                  does not verify them.
                </p>
              )}
            </section>
          )}
          {workflow.status === 'awaiting_fix' && (
            <>
              <label>
                Reason for accepted fixes
                <input value={reason} onChange={(event) => setReason(event.target.value)} />
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
              <label>
                Evidence references for dismissal
                <input
                  value={dismissalEvidence}
                  onChange={(event) => setDismissalEvidence(event.target.value)}
                />
              </label>
              <p>
                Every open finding needs an explicit decision before the builder can run. Dismissal
                uses the reason above and requires evidence.
              </p>
            </>
          )}
          {workflow.status === 'awaiting_initial' && (
            <>
              <p>The selected limits are saved. Initial implementation has not been recorded.</p>
              <button
                disabled={busy || !available || Boolean(pending)}
                onClick={() => void action(endpoint, { action: 'initial' })}
              >
                Run initial implementation
              </button>
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
            <>
              {pendingPreparation && (
                <p>
                  Saved preparation: {pendingPreparation.kind} · {pendingPreparation.attemptId}
                </p>
              )}
              <button
                disabled={busy || !available || !recoveryKind}
                onClick={() =>
                  void action(endpoint, {
                    action: 'recover',
                    attemptId: pending.attemptId,
                    kind: recoveryKind,
                  })
                }
              >
                {pendingPreparation ? 'Recover saved preparation' : 'Recover completed attempt'}
              </button>
            </>
          )}
          {workflow.status === 'awaiting_evidence' && (
            <>
              <label>
                Host verification reference
                <input value={evidenceId} onChange={(event) => setEvidenceId(event.target.value)} />
              </label>
              <button
                disabled={busy || !available || !evidenceId.trim()}
                onClick={() =>
                  void action(endpoint, { action: 'evidence', evidenceId: evidenceId.trim() })
                }
              >
                Attach verification
              </button>
              <p>Use a completed host check reference. Verification must match this artifact.</p>
            </>
          )}
          {['awaiting_evidence', 'verified'].includes(workflow.status) && (
            <button
              disabled={busy || !available}
              onClick={() => void action(endpoint, { action: 'review-record' })}
            >
              Prepare PR review record
            </button>
          )}
          <SymposiumReviewHistory
            key={workflow.workflowId}
            url={`${base}/${encodeURIComponent(workflow.workflowId)}`}
            version={historyVersion}
          />
        </>
      )}
      {loaded && available && !workflow && !hasApplicationRun && (
        <>
          {criterionChecks.length > 0 && (
            <div>
              <label>
                Registered criterion check
                <select
                  value={selectedCheck}
                  onChange={(event) => setSelectedCheck(event.target.value)}
                >
                  <option value="">Select a check</option>
                  {criterionChecks.map((check) => (
                    <option key={check.id} value={check.id}>
                      {check.criterion} · {check.path}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!selectedCheck || busy}
                onClick={() => {
                  const check = criterionChecks.find((item) => item.id === selectedCheck);
                  if (!check) return;
                  setCriteria((current) => {
                    const lines = current
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean);
                    return lines.includes(check.criterion)
                      ? current
                      : [...lines, check.criterion].join('\n');
                  });
                  setSelectedCheck('');
                }}
              >
                Add registered criterion
              </button>
            </div>
          )}
          <label>
            Acceptance criteria (one per line)
            <textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} />
          </label>
          <p>
            Free-form criteria require separate trusted host evidence. Registered checks are
            available above.
          </p>
          {limitFields}
          {applicationRun.available && applicationRun.initialArtifact ? (
            <p>
              Initial artifact: {applicationRun.initialArtifact.revision} · SHA-256:{' '}
              {applicationRun.initialArtifact.hash}
            </p>
          ) : (
            <p>
              A verified initial artifact is required before creating an implementation and review
              run.
            </p>
          )}
          <button
            disabled={
              busy ||
              !criteria.trim() ||
              !validLimits ||
              !applicationRun.available ||
              !applicationRun.initialArtifact
            }
            onClick={() => {
              const artifact = applicationRun.initialArtifact;
              if (!artifact) return;
              void action(`${base}/application-runs`, {
                workflowId: crypto.randomUUID(),
                acceptanceCriteria: criteria
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
                limits,
                expectedArtifactRevision: artifact.revision,
                expectedArtifactHash: artifact.hash,
              });
            }}
          >
            Create implementation and review run
          </button>
          <p>
            Creates a run before implementation. Its initial turn starts only when you choose Run
            initial implementation.
          </p>
        </>
      )}
      {record && (
        <label>
          Current revision review record
          <textarea readOnly value={record} />
          {recordReference && (
            <>
              <button
                type="button"
                aria-expanded={savedRecordOpen}
                onClick={() => setSavedRecordOpen((open) => !open)}
              >
                {savedRecordOpen ? 'Close saved review record' : 'Open saved review record'}
              </button>
              <a
                href={`/sessions/${encodeURIComponent(sessionId)}/review-records/${encodeURIComponent(recordReference.id)}?hash=${encodeURIComponent(recordReference.hash)}`}
              >
                Permanent saved review link
              </a>
              <span>SHA-256: {recordReference.hash}</span>
            </>
          )}
          <span>This immutable record requires your Mitzo login. No PR has been created.</span>
        </label>
      )}
      {record && recordReference && savedRecordOpen && (
        <SymposiumSavedReviewRecord
          key={recordReference.id}
          url={`${base}/records/${encodeURIComponent(recordReference.id)}`}
          reference={recordReference}
        />
      )}
      <SymposiumPublication sessionId={sessionId} record={recordReference} />
      <button
        disabled={busy}
        onClick={() => void reload().catch((error) => setError(String(error)))}
      >
        Refresh review
      </button>
    </section>
  );
}
