import { Link } from 'react-router-dom';
import { type ToolBlock } from '../lib/tool-status';
import { connectionSetupResult } from '../lib/connection-setup-result';
import '../styles/connection-setup-card.css';
export function ConnectionSetupCard({
  block,
  sessionId,
}: {
  block: ToolBlock;
  sessionId?: string;
}) {
  const setup = connectionSetupResult(block, sessionId);
  if (!setup) return null;
  const expired =
    setup.status === 'expired' || (setup.status === 'pending' && setup.expiresAt <= Date.now());
  const ready = setup.status === 'ready';
  const relay = setup.kind === 'relay';
  const unconfirmed = setup.status === 'unconfirmed';
  return (
    <section
      className="connection-setup-chat-card"
      aria-label={`${setup.connection.label} connection setup`}
    >
      <h3>
        {relay
          ? `${setup.connection.label}${ready ? ' saved securely' : ''}`
          : ready
            ? `${setup.connection.label} connected`
            : `Connect ${setup.connection.label}`}
      </h3>
      <p>
        {ready
          ? relay
            ? 'Your value is saved privately. Continue your task here.'
            : 'Your connection is ready. Continue your task here.'
          : expired
            ? 'This setup expired. Ask your assistant to prepare it again.'
            : unconfirmed
              ? 'The save is unconfirmed. Open its status before continuing.'
              : setup.status === 'cancelled'
                ? 'Setup cancelled. You can ask to connect again whenever you need it.'
                : setup.status === 'verifying'
                  ? relay
                    ? 'Mitzo is saving your value securely.'
                    : 'Mitzo is verifying your connection.'
                  : relay
                    ? 'Review the destinations and enter your value privately to continue.'
                    : 'Your assistant has prepared everything. Add your key securely to continue.'}
      </p>
      {!ready && !expired && setup.status !== 'cancelled' && (
        <Link className="workspace-primary" to={setup.setupUrl}>
          {setup.status === 'verifying' || unconfirmed
            ? 'View setup status'
            : `Add ${setup.credential.label}`}
        </Link>
      )}
    </section>
  );
}
