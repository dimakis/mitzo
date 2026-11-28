import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  SpecialistModelPolicySaveSchema,
  SpecialistModelPolicySchema,
  SpecialistModelPolicyViewSchema,
  SpecialistModelPolicyVersionSchema,
  SpecialistAllowanceSummarySchema,
  type SpecialistModelPolicy,
} from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT } from '../lib/api-fetch';
import { createBrowserId } from '../lib/browser-crypto';
import { MotionDetails } from './MotionDetails';
import { SpecialistAllowanceEditor } from './SpecialistAllowanceEditor';

const SettingsSchema = SpecialistModelPolicyViewSchema.extend({
  allowances: z.array(SpecialistAllowanceSummarySchema).default([]),
  accounts: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      models: z.array(z.object({ id: z.string(), label: z.string().optional() })),
    }),
  ),
});
type Settings = z.infer<typeof SettingsSchema>;
const SaveSchema = SpecialistModelPolicySaveSchema.extend({
  scope: z.enum(['workspace', 'conversation']),
});
type Save = z.infer<typeof SaveSchema>;

export function SpecialistModelPolicySettings({ sessionId }: { sessionId: string }) {
  const [requested, setRequested] = useState(false);
  return (
    <MotionDetails
      summary="Model policy"
      summaryClassName="collection-section-toggle"
      onExpandedChange={(open) => {
        if (open) setRequested(true);
      }}
    >
      {requested && <SpecialistModelPolicyEditor key={sessionId} sessionId={sessionId} />}
    </MotionDetails>
  );
}

function SpecialistModelPolicyEditor({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<Settings>();
  const [scope, setScope] = useState<'workspace' | 'conversation'>('conversation');
  const [draft, setDraft] = useState<SpecialistModelPolicy>({ models: [] });
  const [pending, setPending] = useState<Save>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [account, setAccount] = useState('');
  const [model, setModel] = useState('');
  const lifetime = useRef({ generation: 0 });
  const endpoint = `/api/specialist-model-policy/${encodeURIComponent(sessionId)}`;
  const recoveryKey = `mitzo-specialist-policy-save:${sessionId}`;
  const retain = (save?: Save) => {
    setPending(save);
    try {
      if (save) sessionStorage.setItem(recoveryKey, JSON.stringify(save));
      else sessionStorage.removeItem(recoveryKey);
    } catch {
      setStatus('Save recovery is available while this dialog remains open.');
    }
  };
  const load = async (recovery?: Save) => {
    const current = lifetime.current.generation;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(endpoint, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Error('Model policy could not be loaded. Refresh to try again.');
      const value = SettingsSchema.parse(await response.json());
      if (current !== lifetime.current.generation) return;
      setView(value);
      if (recovery) setScope(recovery.scope);
      setDraft(
        structuredClone(
          recovery
            ? (recovery.policy ?? value.workspace.policy ?? { models: [] })
            : (value[scope].policy ?? value.workspace.policy ?? { models: [] }),
        ),
      );
      setAccount(value.accounts[0]?.id ?? '');
    } catch (cause) {
      if (current === lifetime.current.generation)
        setError(cause instanceof Error ? cause.message : 'Model policy unavailable.');
    } finally {
      if (current === lifetime.current.generation) setBusy(false);
    }
  };
  useEffect(() => {
    const owner = lifetime.current;
    let recovery: Save | undefined;
    try {
      const retained = sessionStorage.getItem(recoveryKey);
      if (retained) {
        recovery = SaveSchema.parse(JSON.parse(retained));
        setPending(recovery);
      }
    } catch {
      setError('Saved recovery could not be read. Refresh policy before another save.');
    }
    void load(recovery);
    const retire = () => {
      owner.generation++;
      setView(undefined);
      setPending(undefined);
      setBusy(false);
      setError('Sign in again to edit model policy.');
      try {
        sessionStorage.removeItem(recoveryKey);
      } catch {
        /* Storage may be unavailable. */
      }
    };
    window.addEventListener(AUTH_LOST_EVENT, retire);
    return () => {
      owner.generation++;
      window.removeEventListener(AUTH_LOST_EVENT, retire);
    };
    // The parent keys this component by the ordinary conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const save = async (request: Save) => {
    const current = lifetime.current.generation;
    retain(request);
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const response = await apiFetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(20000),
      });
      const body = await response.json();
      if (current !== lifetime.current.generation) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) retain();
        throw Error(
          typeof body.error === 'string'
            ? body.error
            : 'Save could not be confirmed. Retry the original save.',
        );
      }
      const saved = SpecialistModelPolicyVersionSchema.parse(body);
      retain();
      setView((previous) => previous && { ...previous, [request.scope]: saved });
      setDraft(structuredClone(saved.policy ?? view?.workspace.policy ?? { models: [] }));
      setStatus('Model policy saved. Changes apply to future admissions.');
    } catch (cause) {
      if (current === lifetime.current.generation)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Save could not be confirmed. Retry the original save.',
        );
    } finally {
      if (current === lifetime.current.generation) setBusy(false);
    }
  };
  const submit = (policy: SpecialistModelPolicy | null) => {
    if (!view || busy || pending) return;
    void save({
      requestId: createBrowserId(),
      expectedRevision: view[scope].revision,
      scope,
      policy,
    });
  };
  const change = (index: number, patch: Partial<SpecialistModelPolicy['models'][number]>) =>
    setDraft((old) => ({
      models: old.models.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    }));
  return (
    <>
      <div className="conversation-agent-identity">
        <p>
          Ask reviews each admission. Auto permits admissions under an approved consultation policy.
          Off blocks the model. Agent permissions are reviewed separately.
        </p>
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        {!view && (
          <p role="status">{busy ? 'Loading model policy…' : 'Model policy unavailable.'}</p>
        )}
        <button
          type="button"
          className="conversation-agents-row"
          disabled={busy || !!pending}
          onClick={() => void load()}
        >
          Refresh model policy
        </button>
        {pending && (
          <button
            type="button"
            className="conversation-agents-row"
            disabled={busy}
            onClick={() => void save(pending)}
          >
            Retry original save
          </button>
        )}
        {view && (
          <fieldset disabled={busy || !!pending} className="conversation-agent-identity">
            <legend>Future specialist admissions</legend>
            <label className="conversation-agent-field">
              Apply to
              <select
                value={scope}
                onChange={(event) => {
                  const next = event.target.value as typeof scope;
                  setScope(next);
                  setDraft(
                    structuredClone(view[next].policy ?? view.workspace.policy ?? { models: [] }),
                  );
                }}
              >
                <option value="conversation">This conversation</option>
                <option value="workspace">Workspace defaults</option>
              </select>
            </label>
            <p>
              {scope === 'conversation' && !view.conversation.policy
                ? 'Using workspace defaults. Saving creates a conversation override.'
                : `Saved revision ${view[scope].revision}.`}
            </p>
            {draft.models.map((rule, index) => (
              <div className="conversation-agent-identity" key={`${rule.accountId}:${rule.model}`}>
                <strong>{rule.model}</strong>
                <small>
                  {view.accounts.find((a) => a.id === rule.accountId)?.label ?? rule.accountId}
                </small>
                <label className="conversation-agent-field">
                  Admission for {rule.model}
                  <select
                    value={rule.admission}
                    onChange={(event) =>
                      change(index, { admission: event.target.value as typeof rule.admission })
                    }
                  >
                    <option value="ask">Ask</option>
                    <option value="auto">Auto</option>
                    <option value="off">Off</option>
                  </select>
                </label>
                <label className="conversation-agent-field">
                  Allowance for {rule.model}
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Unlimited"
                    value={rule.allowance ?? ''}
                    onChange={(event) =>
                      change(index, {
                        allowance: event.target.value === '' ? null : Number(event.target.value),
                      })
                    }
                  />
                </label>
                <small>
                  Blank means unlimited. Counts reserved and dispatched consultations in this
                  conversation, across policies.
                </small>
                <button
                  type="button"
                  className="conversation-agents-row"
                  onClick={() => setDraft({ models: draft.models.filter((_, i) => i !== index) })}
                >
                  Remove {rule.model} rule
                </button>
              </div>
            ))}
            <p>Models without a rule use Ask with no additional model allowance.</p>
            <label className="conversation-agent-field">
              Charged account
              <select
                value={account}
                onChange={(event) => {
                  setAccount(event.target.value);
                  setModel('');
                }}
              >
                {view.accounts.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="conversation-agent-field">
              Model ID
              <input
                list={`specialist-models-${sessionId}`}
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            <datalist id={`specialist-models-${sessionId}`}>
              {view.accounts
                .find((a) => a.id === account)
                ?.models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
            </datalist>
            <button
              type="button"
              className="conversation-agents-row"
              disabled={
                !account ||
                !model.trim() ||
                draft.models.some(
                  (rule) => rule.accountId === account && rule.model === model.trim(),
                )
              }
              onClick={() => {
                setDraft({
                  models: [
                    ...draft.models,
                    { accountId: account, model: model.trim(), admission: 'ask', allowance: null },
                  ],
                });
                setModel('');
              }}
            >
              Add model
            </button>
            <button
              type="button"
              className="conversation-agents-row"
              disabled={!SpecialistModelPolicySchema.safeParse(draft).success}
              onClick={() => submit(draft)}
            >
              Save model policy
            </button>
            {scope === 'conversation' && view.conversation.policy && (
              <button
                type="button"
                className="conversation-agents-row"
                onClick={() => submit(null)}
              >
                Use workspace defaults
              </button>
            )}
            {view?.allowances.map((policy) => (
              <SpecialistAllowanceEditor
                key={`${policy.policyId}:${policy.revision}`}
                sessionId={sessionId}
                policy={policy}
              />
            ))}
          </fieldset>
        )}
      </div>
    </>
  );
}
