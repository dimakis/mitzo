import type { SecretRelay } from '../types/secret-relay';
/** The same private setup surface reviews every adapter before capture. Templates
 * contain public configuration only; passwords, OTPs and session state never do. */
export function SecretRelayDestinations({ relay }: { relay: SecretRelay }) {
  return (
    <>
      {relay.targets.map((target, index) => (
        <section
          className="secret-relay-destination"
          key={index}
          aria-label={`Destination ${index + 1}`}
        >
          <h2>{target.label}</h2>
          {(target.adapter === 'mqtt'
            ? target.broker.startsWith('mqtt:')
            : !target.adapter && target.lanEndpoint) && (
            <p role="note">
              This device uses unencrypted {target.adapter === 'mqtt' ? 'MQTT' : 'HTTP'} on your
              local network. Saving permits Mitzo to send the value to this exact address.
            </p>
          )}
          <dl className="connection-setup-summary">
            <div>
              <dt>Service address</dt>
              <dd>{target.endpoint}</dd>
            </div>
            {target.adapter === 'mqtt' ? (
              <>
                <div>
                  <dt>Action</dt>
                  <dd>
                    {target.operation === 'connect'
                      ? 'MQTT authentication check'
                      : 'MQTT publish (QoS 1)'}
                  </dd>
                </div>
                <div>
                  <dt>Username</dt>
                  <dd>{target.username}</dd>
                </div>
                {target.operation === 'publish' && (
                  <>
                    <div>
                      <dt>Topic</dt>
                      <dd>{target.topic}</dd>
                    </div>
                    <div>
                      <dt>Retained message</dt>
                      <dd>{target.retain ? 'Yes' : 'No'}</dd>
                    </div>
                  </>
                )}
              </>
            ) : target.adapter === 'browser' ? (
              <>
                <div>
                  <dt>Action</dt>
                  <dd>Browser sign-in at {target.login.path}</dd>
                </div>
                {target.login.username && (
                  <div>
                    <dt>Username</dt>
                    <dd>{target.login.username}</dd>
                  </div>
                )}
                <div>
                  <dt>Private verification</dt>
                  <dd>
                    {target.mfa
                      ? 'A one-time code may be requested here.'
                      : 'No code step configured.'}
                  </dd>
                </div>
                {target.actions.map((action, i) => (
                  <div key={i}>
                    <dt>Reviewed action {i + 1}</dt>
                    <dd>
                      {action.label} at {action.path}
                    </dd>
                  </div>
                ))}
              </>
            ) : (
              <>
                <div>
                  <dt>Action</dt>
                  <dd>
                    {target.method} {target.path}
                  </dd>
                </div>
                <div>
                  <dt>Secret fields</dt>
                  <dd>{target.fields.join(', ')}</dd>
                </div>
              </>
            )}
          </dl>
          {target.adapter === 'browser' && (
            <p>
              Cookies and browser state stay private in Mitzo until this request expires or is
              revoked. Only the listed actions are available to your assistant.
            </p>
          )}
          <details>
            <summary>
              {target.adapter ? 'Review adapter configuration' : 'Review request template'}
            </summary>
            <pre>{target.adapter ? JSON.stringify(target, null, 2) : target.body}</pre>
          </details>
        </section>
      ))}
    </>
  );
}
