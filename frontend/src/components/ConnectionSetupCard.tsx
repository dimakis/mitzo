import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { OperationCard } from './OperationCard';
import { type ToolBlock } from '../lib/tool-status';
import { connectionSetupResult } from '../lib/connection-setup-result';
export function ConnectionSetupCard({
  block,
  sessionId,
  details,
}: {
  block: ToolBlock;
  sessionId?: string;
  details?: ReactNode;
}) {
  const setup = connectionSetupResult(block, sessionId);
  if (!setup) return null;
  const expired =
    setup.status === 'expired' || (setup.status === 'pending' && setup.expiresAt <= Date.now());
  const ready = setup.status === 'ready';
  const relay = setup.kind === 'relay';
  const unconfirmed = setup.status === 'unconfirmed';
  return (
    <OperationCard
      title={
        relay
          ? `${setup.connection.label}${ready ? ' saved securely' : ''}`
          : ready
            ? `${setup.connection.label} connected`
            : `Connect ${setup.connection.label}`
      }
      kind="Connection setup"
      icon="connections"
      label={`${setup.connection.label} connection setup`}
      pending={!ready && !expired && setup.status !== 'cancelled'}
      scope={
        relay ? 'Private value · reviewed destinations only' : 'Secure setup · this connection'
      }
      status={
        expired
          ? 'Expired'
          : setup.status === 'cancelled'
            ? 'Cancelled'
            : ready
              ? 'Ready'
              : undefined
      }
      actions={
        (!ready || relay) &&
        !expired &&
        setup.status !== 'cancelled' && (
          <Link className="operation-primary" to={setup.setupUrl}>
            {ready && relay
              ? 'Review or revoke'
              : setup.status === 'verifying' || unconfirmed
                ? 'View setup status'
                : `Add ${setup.credential.label}`}
          </Link>
        )
      }
      details={details}
    >
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
    </OperationCard>
  );
}
