import { Link } from 'react-router-dom';
import { useExplicitLocalChat } from '../hooks/useExplicitLocalChat';
import './ChatAgentProfilePicker.css';
export function ChatExecutionPicker({
  runtime,
  disabled = false,
}: {
  runtime: ReturnType<typeof useExplicitLocalChat>;
  disabled?: boolean;
}) {
  if (!runtime.visible) return null;
  if (runtime.bound)
    return (
      <div className="chat-agent-profile">
        <span>Run on: Local · first command only</span>
        <p role="status">{runtime.reason}</p>
      </div>
    );
  const target = runtime.inventory?.targets.find(
    (t) => t.targetId === runtime.intent.execution.targetId,
  );
  const runOn = runtime.selectedLocal
    ? runtime.intent.execution.targetId
      ? `local:${runtime.intent.execution.targetId}`
      : 'local'
    : 'openshell';
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
              (t) => `local:${t.targetId}` === e.target.value,
            );
            runtime.update({
              ...runtime.intent,
              execution: {
                location: selected ? 'local' : 'openshell',
                targetId: selected?.targetId ?? null,
              },
              capabilityRevision: null,
            });
          }}
        >
          <option value="openshell">OpenShell</option>
          {runtime.selectedLocal && !target && (
            <option value={runOn} disabled>
              Local · unavailable
            </option>
          )}
          {runtime.inventory?.targets.map((t) => (
            <option key={t.targetId} value={`local:${t.targetId}`}>
              Local · {t.label}
            </option>
          ))}
          {!runtime.selectedLocal && !runtime.inventory?.targets.length && (
            <option value="local" disabled>
              Local · unavailable
            </option>
          )}
        </select>
      </label>
      {runtime.selectedLocal && (
        <p>
          Local uses a configured signed-in ChatGPT account on this Mac and starts one command.
          Follow-up commands are not available yet.
        </p>
      )}
      {runtime.reason && <span role="status">{runtime.reason}</span>}
      <button type="button" disabled={disabled} onClick={runtime.refresh}>
        Refresh execution choices
      </button>
      {runtime.selectedLocal && runtime.inventory && (
        <button type="button" disabled={disabled} onClick={runtime.review}>
          Use these Local choices
        </button>
      )}
      {runtime.selectedLocal && <Link to="/connections">Connections</Link>}
    </div>
  );
}
