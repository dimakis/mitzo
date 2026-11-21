import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  SpecialistAllowanceEditSchema,
  SpecialistAllowanceSummarySchema,
  SpecialistAllowanceSchema,
} from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT } from '../lib/api-fetch';

type Summary = z.infer<typeof SpecialistAllowanceSummarySchema>;
type Edit = z.infer<typeof SpecialistAllowanceEditSchema>;
export function SpecialistAllowanceEditor({
  sessionId,
  policy,
}: {
  sessionId: string;
  policy: Summary;
}) {
  const [saved, setSaved] = useState(policy);
  const [value, setValue] = useState<number | null>(policy.maxConsultations);
  const [pending, setPending] = useState<Edit>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const lifetime = useRef({ active: true });
  const key = `mitzo-specialist-allowance:${sessionId}:${policy.policyId}`;
  const retain = (edit?: Edit) => {
    setPending(edit);
    try {
      if (edit) sessionStorage.setItem(key, JSON.stringify(edit));
      else sessionStorage.removeItem(key);
    } catch {
      setStatus('Save recovery is available while this dialog remains open.');
    }
  };
  useEffect(() => {
    const owner = lifetime.current;
    owner.active = true;
    try {
      const retained = sessionStorage.getItem(key);
      if (retained) {
        const edit = SpecialistAllowanceEditSchema.parse(JSON.parse(retained));
        setPending(edit);
        setValue(edit.maxConsultations);
      }
    } catch {
      setError('Allowance recovery could not be read. Refresh before editing.');
    }
    const retire = () => {
      owner.active = false;
      setError('Sign in again to edit this allowance.');
      setBusy(false);
    };
    window.addEventListener(AUTH_LOST_EVENT, retire);
    return () => {
      owner.active = false;
      window.removeEventListener(AUTH_LOST_EVENT, retire);
    };
  }, [key]);
  const save = async (edit: Edit) => {
    if (busy || !lifetime.current.active) return;
    retain(edit);
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const response = await apiFetch(
        `/api/specialist-model-policy/${encodeURIComponent(sessionId)}/allowances/${policy.policyId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(edit),
          signal: AbortSignal.timeout(20000),
        },
      );
      const body = await response.json();
      if (!lifetime.current.active) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) retain();
        throw Error(
          typeof body.error === 'string'
            ? body.error
            : 'Allowance save could not be confirmed. Retry the original save.',
        );
      }
      const result = SpecialistAllowanceSummarySchema.parse(body);
      retain();
      setSaved(result);
      setValue(result.maxConsultations);
      setStatus('Consultation allowance saved.');
    } catch (cause) {
      if (lifetime.current.active)
        setError(cause instanceof Error ? cause.message : 'Allowance save could not be confirmed.');
    } finally {
      if (lifetime.current.active) setBusy(false);
    }
  };
  return (
    <div className="conversation-agent-identity">
      <label className="conversation-agent-field">
        Consultation allowance: {saved.roles.join(', ')}
        <input
          type="number"
          min="1"
          step="1"
          placeholder="Unlimited"
          value={value ?? ''}
          disabled={busy || !!pending}
          onChange={(event) =>
            setValue(event.target.value === '' ? null : Number(event.target.value))
          }
        />
      </label>
      <small>
        Blank removes this policy’s call cap. Existing usage is retained. Expires{' '}
        {new Date(saved.expiresAt).toLocaleString()}.
      </small>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <button
        type="button"
        className="conversation-agents-row"
        disabled={busy || !SpecialistAllowanceSchema.safeParse(value).success}
        onClick={() =>
          void save(
            pending ?? {
              requestId: crypto.randomUUID(),
              expectedRevision: saved.revision,
              maxConsultations: value,
            },
          )
        }
      >
        {pending ? 'Retry original allowance save' : 'Save consultation allowance'}
      </button>
    </div>
  );
}
