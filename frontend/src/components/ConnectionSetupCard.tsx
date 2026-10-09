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
  return (
    <section
      className="connection-setup-chat-card"
      aria-label={`${setup.connection.label} connection setup`}
    >
      <h3>{ready ? `${setup.connection.label} connected` : `Connect ${setup.connection.label}`}</h3>
      <p>
        {ready
          ? 'Your connection is ready. Continue your task here.'
          : expired
            ? 'This setup expired. Ask your assistant to prepare it again.'
            : setup.status === 'cancelled'
              ? 'Setup cancelled. You can ask to connect again whenever you need it.'
              : setup.status === 'verifying'
                ? 'Mitzo is verifying your connection.'
                : 'Your assistant has prepared everything. Add your key securely to continue.'}
      </p>
      {!ready && !expired && setup.status !== 'cancelled' && (
        <Link className="workspace-primary" to={setup.setupUrl}>
          {setup.status === 'verifying' ? 'View setup status' : `Add ${setup.credential.label}`}
        </Link>
      )}
    </section>
  );
}
