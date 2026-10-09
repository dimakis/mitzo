import type { WebSocketDraft } from '../types/credential-connections';
export function CredentialWebSocketSettings({
  label,
  draft,
  onChange,
  disabled,
}: {
  label: string;
  draft: WebSocketDraft;
  onChange(value: WebSocketDraft): void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>Service WebSocket</legend>
      <label className="connections-field">
        WebSocket access for {label}
        <select
          value={draft.mode}
          onChange={(e) => {
            const mode = e.target.value as WebSocketDraft['mode'];
            onChange({
              ...draft,
              mode,
              ...(mode === 'home-assistant' ? { path: '/api/websocket' } : {}),
            });
          }}
        >
          <option value="disabled">Disabled</option>
          <option value="headers">Use connection authentication headers</option>
          <option value="home-assistant">Home Assistant authentication exchange</option>
          <option value="custom">Custom JSON authentication exchange</option>
        </select>
      </label>
      {draft.mode !== 'disabled' && (
        <>
          <label className="connections-field">
            WebSocket path for {label}
            <input
              required
              value={draft.path}
              onChange={(e) => onChange({ ...draft, path: e.target.value })}
              placeholder="/ws"
            />
          </label>
          <label className="connections-field">
            WebSocket subprotocols for {label}
            <input
              value={draft.protocols}
              onChange={(e) => onChange({ ...draft, protocols: e.target.value })}
            />
            <span>Optional; separate protocol names with commas. Do not enter credentials.</span>
          </label>
          {draft.mode === 'custom' && (
            <label className="connections-field">
              WebSocket authentication exchange for {label}
              <textarea
                value={draft.authentication}
                onChange={(e) => onChange({ ...draft, authentication: e.target.value })}
                rows={8}
              />
              <span>
                Configure non-secret JSON parameters, the credential field, and the expected
                response. Mitzo inserts the existing Keychain credential privately. Never put a
                token or password here.
              </span>
            </label>
          )}
          <p>
            Uses the connection's service address and allowed paths. Generic messages can change
            service state and require chat approval; Ask mode blocks them.
          </p>
        </>
      )}
    </fieldset>
  );
}
