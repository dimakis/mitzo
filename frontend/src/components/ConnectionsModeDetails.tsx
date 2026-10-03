import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { AccessResource } from '../types/connections-access';
import {
  connectionModes,
  connectionModePolicy,
  connectionRuntimeNotes,
  type ConnectionMode,
} from '../lib/connections-mode-presentation';
import './ConnectionsModeDetails.css';

/** Read-only inspection of configured models and general mode policy, never a chat mode setting. */
export function ConnectionsModeDetails({
  resource,
  catalog,
}: {
  resource: AccessResource;
  catalog?: AccessResource;
}) {
  const models = (catalog ?? resource).details.models ?? [];
  const [modelId, setModelId] = useState(models[0]?.id ?? '');
  const [mode, setMode] = useState<ConnectionMode | null>(null);
  const model = models.find((item) => item.id === modelId) ?? models[0];
  const selectId = useId();
  const backButton = useRef<HTMLButtonElement>(null);
  const modeButtons = useRef<Partial<Record<ConnectionMode, HTMLButtonElement | null>>>({});
  const lastMode = useRef<ConnectionMode | null>(null);
  useLayoutEffect(() => {
    if (mode) backButton.current?.focus();
    else if (lastMode.current) modeButtons.current[lastMode.current]?.focus();
  }, [mode]);
  return (
    <section
      className="access-modes"
      aria-label={`Model and mode reference for ${resource.label}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && mode) {
          event.preventDefault();
          event.stopPropagation();
          setMode(null);
        }
      }}
    >
      <h3>Configured models</h3>
      {models.length ? (
        <>
          <label htmlFor={selectId}>Configured model</label>
          <select
            id={selectId}
            value={model?.id ?? ''}
            onChange={(event) => setModelId(event.target.value)}
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p>No configured models reported.</p>
      )}
      <p className="workspace-muted">
        Runtime and mode availability have not been checked for this account and model.
      </p>
      {mode ? (
        <div className="access-mode-detail">
          <button
            ref={backButton}
            type="button"
            className="workspace-text-link"
            onClick={() => setMode(null)}
          >
            Back to modes
          </button>
          <h3>{connectionModes.find((item) => item.id === mode)?.label} mode</h3>
          <p>
            {resource.label} · {model?.label ?? 'Model not reported'}
          </p>
          <p className="workspace-muted">
            Availability: Not checked. These are general policies; the selected account's runtime
            and model support are unverified.
          </p>
          <dl>
            {connectionModePolicy(mode).map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.text}</dd>
              </div>
            ))}
          </dl>
          <h4>Runtime differences</h4>
          <p className="workspace-muted">{connectionRuntimeNotes}</p>
        </div>
      ) : (
        <>
          <h3>Modes</h3>
          <div className="access-mode-list">
            {connectionModes.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-label={`Inspect ${item.label} mode`}
                ref={(element) => {
                  modeButtons.current[item.id] = element;
                }}
                onClick={() => {
                  lastMode.current = item.id;
                  setMode(item.id);
                }}
              >
                <strong>{item.label}</strong>
                <span>{item.summary}</span>
                <small>Availability: Not checked</small>
              </button>
            ))}
          </div>
        </>
      )}
      <p className="workspace-muted">
        Read-only policy reference. Inspecting a model or mode does not change account settings or a
        chat's mode, and does not establish current conversation access.
      </p>
    </section>
  );
}
