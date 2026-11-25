// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionCard } from '../ConnectionManagement';
import type { ManagedConnection } from '../../types/connections';
import {
  decideConnectionAuthorization,
  takePendingConnectionChange,
} from '../../lib/connection-change-authorization';
import type { PendingConnectionChange } from '../../lib/connection-change-authorization';

const api = vi.hoisted(() => ({ updateAssignments: vi.fn() }));
vi.mock('../../lib/connections-api', () => ({
  deleteConnection: vi.fn(),
  getConnectionCapabilityGrants: vi.fn().mockResolvedValue([]),
  retryConnection: vi.fn(),
  revokeConnection: vi.fn(),
  rotateConnection: vi.fn(),
  setConnectionCapabilityGrant: vi.fn(),
  testConnection: vi.fn(),
  updateAssignments: api.updateAssignments,
}));

const connection = {
  id: 'github',
  templateId: 'github-readonly',
  templateVersion: 1,
  label: 'GitHub',
  status: 'active',
  revision: 4,
  endpoint: 'https://api.github.com',
  publicConfig: { allowedRepositories: ['dimakis/mitzo'] },
  desiredAccountIds: [],
  identity: 'operator',
  verifiedAt: 0,
  errorCode: null,
} as ManagedConnection;

/** Mirrors the page's gate without the passphrase form: identity confirmation
 * issues the fresh csrf that the retained change is then applied with. */
function Harness() {
  const [csrf, setCsrf] = useState('');
  const [pending, setPending] = useState<PendingConnectionChange | null>(null);
  const requireReauthorization = (request?: PendingConnectionChange | true) => {
    const decision = decideConnectionAuthorization(
      { csrf, csrfExpiresAt: 0, connectionsRefreshing: false, loadError: '' },
      request === true ? null : (request ?? null),
      Date.now(),
    );
    if (decision.action === 'proceed') return true;
    setPending(request === true ? null : (request ?? null));
    return false;
  };
  const confirm = async () => {
    const change = takePendingConnectionChange(pending, 'fresh-csrf');
    setPending(null);
    setCsrf('fresh-csrf');
    await change?.run();
  };
  return (
    <>
      <button type="button" onClick={() => void confirm()}>
        Confirm identity
      </button>
      <ConnectionCard
        connection={connection}
        accounts={['claude-account']}
        capabilityCatalog={[]}
        refreshEpoch={0}
        csrf={csrf}
        busy={null}
        rotateOpen={false}
        rotationCredentials={{}}
        requireReauthorization={requireReauthorization}
        pendingChange={pending}
        onConfirmIdentity={() => void confirm()}
        onRotateOpen={vi.fn()}
        onRotationCredentials={vi.fn()}
        onRotateClose={vi.fn()}
        onAction={async (_name, action) => {
          await action();
          return true;
        }}
        onAudit={vi.fn()}
      />
    </>
  );
}

const checkbox = () => screen.getByRole('checkbox', { name: 'claude-account' });

beforeEach(() => {
  api.updateAssignments.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('AI accounts with access', () => {
  it('keeps and names a tap that has no fresh csrf instead of dropping it', () => {
    render(<Harness />);
    fireEvent.click(checkbox());
    expect(api.updateAssignments).not.toHaveBeenCalled();
    expect((checkbox() as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Add claude-account for GitHub/)).toBeTruthy();
  });

  it('applies the retained change with the csrf issued by confirmation', async () => {
    render(<Harness />);
    fireEvent.click(checkbox());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm your identity' }));
    await waitFor(() =>
      expect(api.updateAssignments).toHaveBeenCalledWith({
        id: 'github',
        revision: 4,
        accountIds: ['claude-account'],
        csrf: 'fresh-csrf',
      }),
    );
  });
});
