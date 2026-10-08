import type { PublicCredentialConnection } from './credential-connections.js';
import type { AccountProfiles } from './account-profiles.js';
import type { Connection } from './connections-store.js';
import type { PersonalConnection } from './symposium-personal-connections.js';
import type { GoogleWorkspaceHealth } from './google-workspace-management.js';
import type { CapabilityGrant } from './connections/capabilities/types.js';
import type { SuccessfulAccountUse } from './account-use-store.js';
import type {
  AccessResource,
  AccessResourceKind,
  ConnectionsAccessInventory,
} from './connections-access-types.js';

export interface LegacyAccessProvider {
  name: string;
  type: string;
  id?: string;
  workspace?: string;
}
type AccountAccessProfile = ReturnType<AccountProfiles['catalog']>[number] & {
  lastSuccessfulUse?: SuccessfulAccountUse;
};
type ManagedAccessConnection = Connection & {
  capabilityGrants?: readonly CapabilityGrant[];
  publishingEnabled?: boolean;
};
export interface ConnectionsAccessSources {
  accounts?: (signal: AbortSignal) => AccountAccessProfile[] | Promise<AccountAccessProfile[]>;
  symposiumAccounts?: (
    signal: AbortSignal,
  ) => AccountAccessProfile[] | Promise<AccountAccessProfile[]>;
  /** Server-owned enrollment only; presence is not proof of credential health. */
  canManageOpenAIKey?: (accountId: string) => boolean;
  managed?: () => ManagedAccessConnection[];
  keychain?: () => PublicCredentialConnection[];
  personal?: (signal: AbortSignal) => PersonalConnection[] | Promise<PersonalConnection[]>;
  google?: (signal: AbortSignal) => Promise<GoogleWorkspaceHealth>;
  legacy?: () => Promise<LegacyAccessProvider[]>;
  gateway?: string;
  workspace?: string;
}

function serviceName(provider: string): string | undefined {
  return (
    {
      'github-readonly': 'GitHub',
      github: 'GitHub',
      'jira-readonly': 'Jira',
      jira: 'Jira',
      'google-workspace': 'Google Workspace',
    } as Record<string, string>
  )[provider];
}
export function inventoryIdentity(
  kind: AccessResourceKind,
  owner: string,
  gateway: string | null,
  workspace: string | null,
  nativeId: string,
): string {
  return JSON.stringify([kind, owner, gateway, workspace, nativeId]);
}
function base(
  kind: AccessResourceKind,
  owner: string,
  nativeId: string,
  label: string,
  provider: string,
  gateway: string | null = null,
  workspace: string | null = null,
): AccessResource {
  return {
    id: inventoryIdentity(kind, owner, gateway, workspace, nativeId),
    kind,
    section: kind === 'ai-account' || kind === 'personal-connection' ? 'accounts' : 'services',
    owner,
    nativeId,
    gateway,
    workspace,
    label,
    provider,
    status: 'configured',
    revision: null,
    accountIdentity: null,
    verification: {
      state: 'unverified',
      verifiedAt: null,
      reason: 'Effective access has not been checked.',
    },
    access: {
      summary: 'Configured access',
      desiredAccountIds: [],
      observedAttachments: null,
      appliesTo: 'Not checked for existing conversations',
    },
    actions: [],
    details: {},
  };
}
/** Each source has an independent deadline; failures never export exception text. */
export async function readConnectionsAccess(
  input: ConnectionsAccessSources,
  options: { now?: number; timeoutMs?: number } = {},
): Promise<ConnectionsAccessInventory> {
  const now = options.now ?? Date.now();
  const result: ConnectionsAccessInventory = { generatedAt: now, resources: [], sources: [] };
  const keys = [
    'accounts',
    'symposiumAccounts',
    'managed',
    'personal',
    'google',
    'legacy',
    ...(input.keychain ? ['keychain' as const] : []),
  ] as const;
  const reads = await Promise.all(
    keys.map(async (id) => {
      const read = input[id];
      if (!read) return { id, state: 'not-configured' as const, value: undefined };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          Promise.resolve().then<unknown>(() => read(controller.signal)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('Source timeout'));
            }, options.timeoutMs ?? 5_000);
          }),
        ]);
        return { id, state: 'available' as const, value };
      } catch {
        return { id, state: 'unavailable' as const, value: undefined };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  for (const read of reads)
    result.sources.push({
      id: read.id,
      state: read.state,
      reason:
        read.state === 'available'
          ? null
          : read.state === 'not-configured'
            ? 'This source is not configured.'
            : 'This source could not be checked. Retry later.',
    });
  const value = <T>(id: (typeof keys)[number]) =>
    reads.find((r) => r.id === id)?.value as T | undefined;
  for (const source of ['accounts', 'symposiumAccounts'] as const) {
    for (const account of value<AccountAccessProfile[]>(source) ?? []) {
      const row = base(
        'ai-account',
        source === 'accounts' ? 'account-profiles' : 'symposium-account-profiles',
        account.id,
        account.label,
        account.provider,
      );
      row.access.summary =
        source === 'accounts'
          ? 'Configured models; sign-in and effective access not checked'
          : 'Configured Symposium models; sign-in and effective access not checked';
      if (
        source === 'symposiumAccounts' &&
        account.provider === 'openai-codex' &&
        account.personalConnection
      ) {
        const link = account.personalConnection;
        const personal = (value<PersonalConnection[]>('personal') ?? []).filter(
          (row) => row.id === link.id,
        );
        const available = reads.find((read) => read.id === 'personal')?.state === 'available';
        row.personalConnection = {
          resourceId: inventoryIdentity(
            'personal-connection',
            'symposium-personal',
            null,
            null,
            link.id,
          ),
          revision: link.revision,
          state: !available
            ? 'unavailable'
            : personal.length === 1 &&
                personal[0].state === 'connected' &&
                personal[0].revision === link.revision
              ? 'current'
              : 'stale',
        };
      }
      if (account.signIn) {
        row.signIn = account.signIn;
        row.accountIdentity = account.signIn.observedIdentity?.email ?? null;
        row.access.summary = 'Configured models; effective conversation access not checked';
      }
      row.details = {
        billing: account.billing,
        models: account.models.map((model) => ({ id: model.id, label: model.label })),
      };
      if (
        account.lastSuccessfulUse &&
        Number.isSafeInteger(account.lastSuccessfulUse.succeededAt) &&
        account.lastSuccessfulUse.succeededAt >= 0 &&
        account.lastSuccessfulUse.succeededAt <= now &&
        (account.lastSuccessfulUse.model === null ||
          account.models.some((model) => model.id === account.lastSuccessfulUse!.model))
      )
        row.lastSuccessfulUse = { ...account.lastSuccessfulUse };
      const keyManaged =
        source === 'accounts' &&
        account.provider === 'openai' &&
        input.canManageOpenAIKey?.(account.id);
      if (keyManaged)
        row.actions = [
          {
            id: 'openai-key-controls',
            label: 'Manage API key',
            href: `/connections?manage=openai&connection=${encodeURIComponent(account.id)}`,
          },
        ];
      row.verification.reason =
        account.signIn || keyManaged
          ? 'Effective conversation access has not been checked.'
          : 'Configured account profile only. Credential controls are unavailable here; sign-in and effective access have not been checked.';
      result.resources.push(row);
    }
  }
  const managed = (
    value<ReturnType<NonNullable<ConnectionsAccessSources['managed']>>>('managed') ?? []
  ).filter((c) => !c.archivedAt);
  for (const connection of managed) {
    const row = base(
      'managed-connection',
      connection.ownerId,
      connection.id,
      connection.label,
      connection.templateId,
      connection.gateway,
      connection.workspace,
    );
    row.status = connection.status;
    row.errorCode = connection.errorCode;
    row.revision = connection.revision;
    row.accountIdentity = connection.identity;
    const verifiedAt =
      connection.verifiedAt !== null &&
      Number.isFinite(connection.verifiedAt) &&
      connection.verifiedAt <= now
        ? connection.verifiedAt
        : null;
    row.verification = {
      state: verifiedAt !== null ? 'verified' : 'unverified',
      verifiedAt,
      reason:
        verifiedAt !== null
          ? 'The last credential check passed at the recorded time. Current conversation access has not been checked.'
          : 'No successful credential check has been recorded. Current conversation access has not been checked.',
    };
    row.access = {
      summary: 'Managed service permissions',
      desiredAccountIds: [...connection.desiredAccountIds],
      observedAttachments: null,
      appliesTo: 'New conversations only',
    };
    const permissions =
      connection.templateId === 'github-readonly'
        ? ['Repository reads']
        : connection.templateId === 'jira-readonly'
          ? ['Jira reads']
          : connection.templateId === 'custom-rest-readonly'
            ? ['API reads']
            : [];
    if (
      connection.status === 'active' &&
      connection.publishingEnabled &&
      connection.capabilityGrants?.some(
        (grant) =>
          grant.connectionId === connection.id &&
          grant.connectionRevision === connection.revision &&
          grant.status === 'active' &&
          grant.capabilityId === 'github.publish-pr' &&
          grant.capabilityVersion === 1 &&
          grant.accountIds.some((id) => connection.desiredAccountIds.includes(id)),
      )
    )
      permissions.push('PR publishing after approval');
    row.details = {
      endpoint: connection.endpoint,
      serviceName: serviceName(connection.templateId),
      configuredIdentity:
        typeof connection.publicConfig.email === 'string'
          ? connection.publicConfig.email
          : connection.submittedEmail || undefined,
      scope: { ...connection.publicConfig },
      permissions,
    };
    row.actions = [
      {
        id: 'connection-controls',
        label: 'Manage service',
        href: `/connections?manage=service&connection=${encodeURIComponent(connection.id)}`,
      },
    ];
    result.resources.push(row);
  }
  for (const connection of value<PublicCredentialConnection[]>('keychain') ?? []) {
    const row = base(
      'keychain-connection',
      'keychain-controller',
      connection.id,
      connection.label,
      'Apple Keychain',
    );
    row.status = connection.status;
    row.revision = connection.revision;
    row.accountIdentity = connection.auth.kind === 'basic' ? connection.auth.username : null;
    row.details.endpoint = connection.endpoint;
    row.verification = {
      state:
        connection.status === 'disabled'
          ? 'unavailable'
          : connection.verifiedAt
            ? 'verified'
            : 'unverified',
      verifiedAt: connection.verifiedAt,
      reason: connection.verifiedAt
        ? 'An authenticated read succeeded; access still requires session approval.'
        : 'The saved credential has not been tested against this service.',
    };
    row.access.summary = `${connection.methods.join(', ')} on ${connection.paths.join(', ')} through the trusted Keychain provider · HA dashboard WebSocket: ${connection.homeAssistantDashboards ?? 'disabled'}`;
    row.access.appliesTo = 'Explicit approval in each session';
    row.actions = [
      {
        id: 'keychain-controls',
        label: 'Manage Keychain connection',
        href: `/connections?manage=keychain&connection=${encodeURIComponent(connection.id)}`,
      },
    ];
    result.resources.push(row);
  }
  for (const connection of value<PersonalConnection[]>('personal') ?? []) {
    const row = base(
      'personal-connection',
      'symposium-personal',
      connection.id,
      connection.label,
      'openai-codex',
    );
    row.status = connection.state;
    row.revision = connection.revision;
    row.accountIdentity = connection.account?.email ?? null;
    row.verification.reason =
      'Personal connection metadata does not verify current sign-in or access.';
    row.details = connection.account ? { billing: `ChatGPT ${connection.account.planType}` } : {};
    row.access.summary = 'Personal ChatGPT connection';
    row.actions = [
      {
        id: 'personal-controls',
        label: 'Manage account',
        href: `/connections?manage=personal&connection=${encodeURIComponent(connection.id)}`,
      },
    ];
    result.resources.push(row);
  }
  const gateway = input.gateway ?? null,
    workspace = input.workspace ?? null;
  const google = value<GoogleWorkspaceHealth>('google');
  if (google && google.health !== 'not_configured') {
    const row = base(
      'google-workspace',
      'google-workspace-management',
      'google-workspace',
      'Google Workspace',
      'google-workspace',
      gateway,
      workspace,
    );
    row.status = google.health;
    row.verification = {
      state:
        google.health === 'ready'
          ? 'verified'
          : google.health === 'unavailable'
            ? 'unavailable'
            : 'unverified',
      verifiedAt: google.health === 'ready' ? now : null,
      reason:
        'Reviewed provider and credential refresh status; account identity and conversation attachments not checked.',
    };
    row.access.summary = google.slidesEditing
      ? 'Reviewed Google reads and bounded Slides editing'
      : 'Google permissions could not be checked';
    row.access.appliesTo = 'New conversations only';
    row.details = {
      serviceName: 'Google Workspace',
      expiresAt: google.expiresAt,
      permissions:
        google.health === 'ready'
          ? ['Google reads', ...(google.slidesEditing ? ['Slides editing'] : [])]
          : [],
    };
    row.actions = [
      {
        id: 'google-controls',
        label: 'Manage Google Workspace',
        href: '/connections?manage=google',
      },
    ];
    result.resources.push(row);
    if (google.health === 'unavailable') {
      const source = result.sources.find((s) => s.id === 'google')!;
      source.state = 'unavailable';
      source.reason = 'Google access could not be checked. Retry later.';
    }
  }
  for (const provider of value<LegacyAccessProvider[]>('legacy') ?? []) {
    // Labels alone are not identity; match only authoritative primary scope.
    if (
      gateway !== null &&
      workspace !== null &&
      (managed.filter(
        (c) =>
          c.gateway === gateway &&
          c.workspace === workspace &&
          c.gatewayProviderName === provider.name &&
          provider.id !== undefined &&
          c.gatewayProviderId === provider.id &&
          provider.workspace !== undefined &&
          provider.workspace === c.workspace,
      ).length === 1 ||
        (google &&
          google.health !== 'not_configured' &&
          google.health !== 'unavailable' &&
          provider.name === 'google-workspace' &&
          google.providerIdentity !== undefined &&
          provider.id === google.providerIdentity.id &&
          provider.workspace === google.providerIdentity.workspace &&
          google.providerIdentity.workspace === workspace))
    )
      continue;
    const row = base(
      'legacy-provider',
      'operator-managed',
      provider.name,
      provider.name,
      provider.type,
      gateway,
      provider.workspace ?? workspace,
    );
    row.status = 'operator-managed';
    row.access.summary = 'Operator-managed policy; permissions not checked';
    row.details.serviceName = serviceName(provider.name) ?? serviceName(provider.type);
    row.actions = [
      {
        id: 'legacy-details',
        label: 'Provider details',
        href: `/connections?manage=legacy&connection=${encodeURIComponent(provider.name)}`,
      },
    ];
    result.resources.push(row);
  }
  return result;
}
