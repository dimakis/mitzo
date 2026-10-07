import { expect, it } from 'vitest';
import {
  accountSignInIdentity,
  accountSignInLabel,
  connectionTitle,
  connectionStatus,
  serviceIdentity,
} from '../connections-access-presentation';
import type { AccessResource } from '../../types/connections-access';

const resource: AccessResource = {
  id: 'work',
  kind: 'ai-account',
  section: 'accounts',
  owner: 'account-profiles',
  nativeId: 'work',
  gateway: null,
  workspace: null,
  label: 'Work',
  provider: 'openai-codex',
  status: 'configured',
  revision: null,
  accountIdentity: null,
  verification: { state: 'unverified', verifiedAt: null, reason: null },
  access: {
    summary: 'Configured models',
    desiredAccountIds: [],
    observedAttachments: null,
    appliesTo: 'New conversations',
  },
  actions: [],
  details: {},
};
it('treats an old passed sign-in check as history and a timed-out check as uncertainty', () => {
  const signIn = {
    status: 'stale' as const,
    source: 'openshell-provider-grant' as const,
    checkedAt: 100,
    configuredIdentity: { email: 'brokered-subscription@local.invalid', planType: 'pro' },
    observedIdentity: null,
    profileRevision: 'route',
    explanation: 'Last check',
  };
  expect(accountSignInLabel({ ...resource, signIn })).toBe('Last sign-in check passed');
  expect(accountSignInIdentity({ ...resource, signIn }).configuredEmail).toBeNull();
  expect(
    accountSignInLabel({
      ...resource,
      signIn: { ...signIn, status: 'failed', explanation: 'Check timed out' },
    }),
  ).toBe("Couldn't check sign-in");
  expect(connectionStatus({ ...resource, status: 'reauth_required' })).toBe('Reconnect required');
});
it('keeps enablement, credential checks and usage distinct', () => {
  expect(connectionStatus(resource)).toBe('Set up');
  expect(
    connectionStatus({
      ...resource,
      kind: 'managed-connection',
      status: 'active',
      verification: { state: 'stale', verifiedAt: 100, reason: null },
    }),
  ).toBe('Connection enabled');
});
it('requests reconnection only after an explicit authentication rejection', () => {
  const service = {
    ...resource,
    kind: 'managed-connection' as const,
    section: 'services' as const,
    status: 'needs_attention',
  };
  expect(connectionStatus({ ...service, errorCode: 'JIRA_AUTH_REJECTED' })).toBe(
    'Reconnect required',
  );
  expect(connectionStatus({ ...service, errorCode: 'JIRA_NETWORK_FAILED' })).toBe(
    'Needs attention',
  );
  expect(connectionStatus({ ...service, status: 'revoked', errorCode: 'JIRA_AUTH_REJECTED' })).toBe(
    'Revoked',
  );
});
it('labels additional GitHub access without merging it by service name and distinguishes configured Jira identity', () => {
  const managed = {
    ...resource,
    kind: 'managed-connection' as const,
    section: 'services' as const,
    label: 'GitHub · dimakis/mgmt',
    details: { serviceName: 'GitHub' },
  };
  const legacy = {
    ...managed,
    id: 'legacy',
    kind: 'legacy-provider' as const,
    label: 'github',
    nativeId: 'github',
  };
  expect(connectionTitle(legacy, [managed, legacy])).toBe('GitHub · additional connection');
  expect(connectionTitle(legacy, [legacy])).toBe('GitHub');
  expect(
    serviceIdentity({
      ...managed,
      accountIdentity: '712020:01234567-1234-1234-1234-123456789012',
      details: { serviceName: 'Jira', configuredIdentity: 'person@example.com' },
    }),
  ).toBe('Configured account: person@example.com');
});
