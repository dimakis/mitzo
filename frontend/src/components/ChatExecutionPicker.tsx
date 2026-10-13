import { Link, useNavigate } from 'react-router-dom';
import { createChatDraft, saveChatDraft } from '../lib/chat-drafts';
import { useState } from 'react';
import { useExplicitLocalChat } from '../hooks/useExplicitLocalChat';
import './ChatAgentProfilePicker.css';
export function ChatExecutionPicker({
  runtime,
  disabled = false,
}: {
  runtime: ReturnType<typeof useExplicitLocalChat>;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const [draftError, setDraftError] = useState('');
  const startElsewhere = () => {
    const draft = createChatDraft();
    const location = runtime.binding?.execution.location === 'openshell' ? 'local' : 'openshell';
    draft.settings = {
      ...draft.settings,
      retainRuntimeIntent: true,
      runtimeSelection: {
        ...runtime.intent,
        execution: { location, targetId: null },
        capabilityRevision: null,
      },
      selection: runtime.intent.account,
      repositoryWorkspaceId: null,
    };
    if (!saveChatDraft(draft)) {
      setDraftError('Could not save the new conversation draft. Retry.');
      return;
    }
    navigate(`/chat?draft=${encodeURIComponent(draft.id)}`);
  };
  if (!runtime.visible) return null;
  const selectedRoute = runtime.inventory?.routes.find(
    (route) =>
      route.account.accountId === runtime.intent.account?.accountId &&
      route.targetId === runtime.intent.execution.targetId,
  );
  const harness = runtime.bound ? runtime.binding?.harness.implementation : selectedRoute?.harness;
  const software =
    harness === 'codex'
      ? 'Codex'
      : harness === 'responses'
        ? 'Mitzo Responses'
        : harness === 'claude-sdk'
          ? 'Claude'
          : harness === 'gemini'
            ? 'Gemini'
            : undefined;
  if (runtime.metadataUnavailable)
    return (
      <div className="chat-agent-profile">
        <span role="alert">{runtime.reason}</span>
        <button type="button" onClick={runtime.refresh}>
          Retry conversation settings
        </button>
      </div>
    );
  if (runtime.bound)
    return (
      <div className="chat-agent-profile">
        <span>
          {runtime.continuation
            ? `Run on: ${runtime.binding?.execution.location === 'openshell' ? 'OpenShell' : 'Local Mac'} · fixed for this conversation`
            : `Run on: ${runtime.binding?.execution.location === 'openshell' ? 'OpenShell' : 'Local'} · first command only`}
        </span>
        {software && <span>Runs with {software}</span>}
        <p role="status">{runtime.reason}</p>
        <button
          type="button"
          disabled={!runtime.intent.account || !runtime.intent.agentProfile}
          onClick={startElsewhere}
        >
          New session on{' '}
          {runtime.binding?.execution.location === 'openshell' ? 'Local Mac' : 'OpenShell'}
        </button>
        <span>
          Starts a separate conversation and checkout using the same agent and account. Prepare its
          repository before sending.
        </span>
        {draftError && <span role="alert">{draftError}</span>}
        {runtime.continuation && (
          <>
            <span>Model and thinking changes apply to the next message.</span>
            <button type="button" disabled={disabled} onClick={runtime.review}>
              Use these conversation choices
            </button>
          </>
        )}
      </div>
    );
  const target = runtime.inventory?.targets.find(
    (t) => t.targetId === runtime.intent.execution.targetId,
  );
  const runOn = runtime.intent.execution.targetId
    ? `${runtime.intent.execution.location}:${runtime.intent.execution.targetId}`
    : runtime.intent.execution.location;
  return (
    <div className="chat-agent-profile">
      <label>
        Run on
        <select
          aria-label="Run on"
          disabled={disabled || !runtime.inventory}
          value={runOn}
          onChange={(e) => {
            const selected = runtime.inventory?.targets.find(
              (t) => `${t.location}:${t.targetId}` === e.target.value,
            );
            runtime.update({
              ...runtime.intent,
              execution: {
                location: selected?.location ?? 'openshell',
                targetId: selected?.targetId ?? null,
              },
              capabilityRevision: null,
            });
          }}
        >
          <option value="openshell">OpenShell</option>
          {runtime.intent.execution.targetId && !target && (
            <option value={runOn} disabled>
              {runtime.selectedLocal ? 'Local Mac' : 'OpenShell'} · unavailable
            </option>
          )}
          {runtime.inventory?.targets.map((t) => (
            <option key={t.targetId} value={`${t.location}:${t.targetId}`}>
              {t.location === 'local' ? 'Local' : 'OpenShell'} · {t.label}
            </option>
          ))}
          {!runtime.selectedLocal &&
            !runtime.inventory?.targets.some((target) => target.location === 'local') && (
              <option value="local" disabled>
                Local · unavailable
              </option>
            )}
        </select>
      </label>
      {software && <p>Runs with {software}</p>}
      {runtime.selectedLocal && (
        <p>
          Local Mac uses a configured signed-in ChatGPT account and a separate checkout. The
          admitted conversation keeps its account and execution location.
        </p>
      )}
      {runtime.reason && <span role="status">{runtime.reason}</span>}
      <button type="button" disabled={disabled} onClick={runtime.refresh}>
        Refresh execution choices
      </button>
      {runtime.inventory && (
        <button type="button" disabled={disabled} onClick={runtime.review}>
          {runtime.selectedLocal ? 'Use these Local choices' : 'Use these OpenShell choices'}
        </button>
      )}
      {runtime.selectedLocal && <Link to="/connections">Connections</Link>}
    </div>
  );
}
