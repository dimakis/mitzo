import type { AccountProfiles } from './account-profiles.js';
import type { Connection } from './connections-store.js';
import type { PersonalConnection } from './symposium-personal-connections.js';
import type { GoogleWorkspaceHealth } from './google-workspace-management.js';
import type {
  AccessResource,
  AccessResourceKind,
  ConnectionsAccessInventory,
} from './connections-access-types.js';

export interface ConnectionsAccessSources {
  accounts?: (
    signal: AbortSignal,
  ) => ReturnType<AccountProfiles['catalog']> | Promise<ReturnType<AccountProfiles['catalog']>>;
  symposiumAccounts?: (
    signal: AbortSignal,
  ) => ReturnType<AccountProfiles['catalog']> | Promise<ReturnType<AccountProfiles['catalog']>>;
  managed?: () => Connection[];
  personal?: (signal: AbortSignal) => PersonalConnection[] | Promise<PersonalConnection[]>;
  google?: (signal: AbortSignal) => Promise<GoogleWorkspaceHealth>;
  legacy?: () => Promise<Array<{ name: string; type: string }>>;
  gateway?: string;
  workspace?: string;
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
  options: { now?: number; freshnessMs?: number; timeoutMs?: number } = {},
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
    for (const account of value<ReturnType<AccountProfiles['catalog']>>(source) ?? []) {
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
      row.verification.reason = account.signIn
        ? 'Effective conversation access has not been checked.'
        : 'Configured account profile only. Credential controls are unavailable here; sign-in and effective access have not been checked.';
      result.resources.push(row);
    }
  }
  const managed = (value<Connection[]>('managed') ?? []).filter((c) => !c.archivedAt);
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
    row.revision = connection.revision;
    row.accountIdentity = connection.identity;
    row.verification = {
      state:
        connection.status === 'active' &&
        connection.verifiedAt !== null &&
        connection.verifiedAt <= now
          ? now - connection.verifiedAt <= (options.freshnessMs ?? 5 * 60_000)
            ? 'verified'
            : 'stale'
          : 'unverified',
      verifiedAt: connection.verifiedAt,
      reason:
        'Verification describes the credential check; conversation attachments are not checked.',
    };
    row.access = {
      summary: 'Managed service permissions',
      desiredAccountIds: [...connection.desiredAccountIds],
      observedAttachments: null,
      appliesTo: 'New conversations only',
    };
    row.details = { endpoint: connection.endpoint };
    row.actions = [
      { id: 'connection-controls', label: 'Open service controls', href: '/connections' },
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
      { id: 'personal-controls', label: 'Open personal account controls', href: '/connections' },
    ];
    result.resources.push(row);
  }
  const gateway = input.gateway ?? null,
    workspace = input.workspace ?? null;
  const google = value<GoogleWorkspaceHealth>('google');
  if (google) {
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
    row.details = { expiresAt: google.expiresAt };
    row.actions = [{ id: 'google-controls', label: 'Open Google controls', href: '/connections' }];
    result.resources.push(row);
    if (google.health === 'unavailable') {
      const source = result.sources.find((s) => s.id === 'google')!;
      source.state = 'unavailable';
      source.reason = 'Google access could not be checked. Retry later.';
    }
  }
  for (const provider of value<Array<{ name: string; type: string }>>('legacy') ?? []) {
    // Labels alone are not identity; match only authoritative primary scope.
    if (
      gateway !== null &&
      workspace !== null &&
      (managed.some(
        (c) =>
          c.gateway === gateway &&
          c.workspace === workspace &&
          c.gatewayProviderName === provider.name,
      ) ||
        (google &&
          google.health !== 'not_configured' &&
          google.health !== 'unavailable' &&
          provider.name === 'google-workspace'))
    )
      continue;
    const row = base(
      'legacy-provider',
      'operator-managed',
      provider.name,
      provider.name,
      provider.type,
      gateway,
      workspace,
    );
    row.status = 'operator-managed';
    row.access.summary = 'Operator-managed policy; permissions not checked';
    row.actions = [{ id: 'legacy-details', label: 'Open provider details', href: '/connections' }];
    result.resources.push(row);
  }
  return result;
}
