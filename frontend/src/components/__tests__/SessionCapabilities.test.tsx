// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RuntimeReadiness, SessionAccessEvidence } from '@mitzo/protocol';
import { SessionCapabilities } from '../SessionCapabilities';

afterEach(cleanup);
const binding = {
  version: 2 as const,
  account: { accountId: 'account', provider: 'anthropic-claude' as const, profileRevision: 'p1' },
  harness: { implementation: 'claude-sdk' as const },
  execution: { location: 'local' as const, targetId: 'mac', targetRevision: 't1' },
};
function access() {
  return {
    sessionId: 'chat',
    observedAt: 150,
    state: 'current',
    helperSupport: {
      state: 'configured',
      tools: [
        {
          name: 'ListConnections',
          source: 'Connections',
          requirement: 'Existing permissions apply.',
          state: 'supported',
        },
        {
          name: 'ConnectionRequest',
          source: 'Connections',
          requirement: 'Existing permissions apply.',
          state: 'unsupported',
        },
      ],
    },
    readiness: {
      version: 1,
      sessionId: 'chat',
      observedAt: 150,
      revision: 'a'.repeat(64),
      execution: { state: 'configured', binding },
      capabilities: { state: 'unknown', reason: 'not_observed' },
      session: { state: 'unknown', reason: 'not_observed' },
    },
  } as SessionAccessEvidence;
}
function measured(): RuntimeReadiness['capabilities'] {
  return {
    state: 'observed',
    evidence: {
      scope: {
        sessionId: 'chat',
        accountId: 'account',
        profileRevision: 'p1',
        model: 'model',
        binding,
        ownerRevision: 'owner1',
      },
      observedAt: 100,
      expiresAt: 200,
      process: 'ready',
      roots: { task: '/task', knowledge: null },
      tools: [{ name: 'ListConnections', state: 'available' }],
      executables: [],
      services: [
        {
          id: 'Documents',
          revision: 'service1',
          configured: 'yes',
          approval: 'unknown',
          attachment: 'unknown',
          operations: [
            {
              operation: 'list',
              policy: 'allowed',
              verification: { state: 'succeeded', observedAt: 100, expiresAt: 175 },
            },
            { operation: 'read text', policy: 'unknown', verification: { state: 'unknown' } },
          ],
        },
      ],
    },
  };
}
describe('capabilities from the real Access projection', () => {
  it('separates catalog support from execution verification without adding actions', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const value = access();
    render(<SessionCapabilities evidence={value} stale={false} now={150} />);
    expect(screen.getByText(/Configured support does not verify execution/)).toBeTruthy();
    expect(screen.getAllByText('ListConnections').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unsupported on this route').length).toBeGreaterThan(0);
    expect(
      screen.getByText('Unknown — this runtime has not supplied capability observations.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it('keeps a successful list independent of document-text verification and expires individual results', () => {
    const value = access();
    value.readiness.capabilities = measured();
    const { rerender } = render(<SessionCapabilities evidence={value} stale={false} now={150} />);
    expect(screen.getByText('Succeeded')).toBeTruthy();
    expect(screen.getByText('Not verified')).toBeTruthy();
    expect(screen.getByText('Approval: Unknown · Attachment: Unknown')).toBeTruthy();
    rerender(<SessionCapabilities evidence={value} stale={false} now={180} />);
    expect(screen.getByText('Verification expired — earlier result: succeeded')).toBeTruthy();
    expect(screen.queryByText('Succeeded')).toBeNull();
    rerender(<SessionCapabilities evidence={value} stale={false} now={210} />);
    expect(screen.getByText(/Capability observation expired/)).toBeTruthy();
    expect(screen.queryByText('Available')).toBeNull();
  });
  it.each(['scope_mismatch', 'owner_unavailable', 'invalid_evidence'] as const)(
    'keeps %s unknown rather than rendering a success',
    (reason) => {
      const value = access();
      value.readiness.capabilities = { state: 'unknown', reason };
      render(<SessionCapabilities evidence={value} stale={false} now={150} />);
      expect(screen.getByText(/Unknown —/)).toBeTruthy();
      expect(screen.queryByText('Succeeded')).toBeNull();
    },
  );
  it('retains earlier observations on refresh failure with explicit stale labels', () => {
    const value = access();
    value.readiness.capabilities = measured();
    render(<SessionCapabilities evidence={value} stale now={150} />);
    expect(screen.getByText(/Earlier capability observation/)).toBeTruthy();
    expect(screen.getByText('Earlier result: succeeded')).toBeTruthy();
    expect(screen.queryByText('Succeeded')).toBeNull();
    fireEvent.click(screen.getByText('Capabilities'));
    expect(screen.getAllByText('ListConnections').length).toBeGreaterThan(0);
  });
});
