import {
  SessionLaunchDefaultsSchema,
  type SessionLaunchConfig,
  type SessionLaunchDefaults,
} from '@mitzo/protocol';
import { apiFetch } from './api-fetch';
import { createChatDraft, type ChatDraft } from './chat-drafts';
import type { ChatRuntimeSelection } from './chat-runtime-selection';

export { SessionLaunchDefaultsSchema, type SessionLaunchDefaults };

export function unsupportedSessionExtraToolsReason(
  tools: string | null | undefined,
  native: boolean,
): string | undefined {
  return native && tools?.split(',').some((tool) => tool.trim())
    ? 'Additional tools are unsupported on the selected runtime. Review session defaults or clear these tools before sending.'
    : undefined;
}
export function unsupportedSessionContextReason(
  blocks: readonly string[],
  native: boolean,
): string | undefined {
  return native && blocks.length
    ? 'Saved context blocks are unsupported on the selected runtime. Review session defaults or clear this context before sending.'
    : undefined;
}

export function savedRepositorySelectionReason(
  savedId: string | null | undefined,
  selected: { repositoryWorkspaceId?: string; blocked: boolean } | null | undefined,
  explicitlyCleared: boolean,
): string | undefined {
  if (
    !savedId ||
    explicitlyCleared ||
    (selected?.repositoryWorkspaceId &&
      selected.repositoryWorkspaceId !== savedId &&
      !selected.blocked)
  )
    return undefined;
  return 'The saved repository needs a fresh checkout. Select its source again, or use the default repository.';
}

export function sessionLaunchRuntime(
  selection: ChatRuntimeSelection,
): SessionLaunchConfig['runtime'] {
  return {
    version: 1,
    account: selection.account?.accountId
      ? { ...selection.account, accountId: selection.account.accountId }
      : null,
    accountReference: selection.accountReference,
    agentProfile: selection.agentProfile,
    execution: { ...selection.execution },
  };
}

async function readDefaults(response: Response): Promise<SessionLaunchDefaults> {
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      typeof body?.error === 'string' ? body.error : 'Could not load session defaults. Retry.',
    );
  return SessionLaunchDefaultsSchema.parse(body);
}
export async function loadSessionLaunchDefaults(
  signal?: AbortSignal,
): Promise<SessionLaunchDefaults> {
  return readDefaults(
    await apiFetch('/api/session-launch/defaults', signal ? { signal } : undefined),
  );
}
export async function saveSessionLaunchDefaults(
  configuration: SessionLaunchConfig | null,
  expectedRevision: number,
): Promise<SessionLaunchDefaults> {
  return readDefaults(
    await apiFetch('/api/session-launch/defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision, configuration }),
    }),
  );
}

/** Preferences retain intent, never a runtime admission or a provider checkpoint. */
export function sessionLaunchConfigurationDraft(configuration: SessionLaunchConfig): ChatDraft {
  const draft = createChatDraft();
  const search = new URLSearchParams();
  const profile = configuration.runtime.agentProfile;
  if (profile) {
    search.set('agentProfile', profile.profileId);
    search.set('profileRevision', String(profile.revision));
    if (profile.kind) search.set('agentProfileKind', profile.kind);
  }
  if (configuration.extraTools.length) search.set('extraTools', configuration.extraTools.join(','));
  return {
    ...draft,
    contextBlocks: [...configuration.contextBlocks],
    settings: {
      ...draft.settings,
      selection: configuration.runtime.account,
      runtimeSelection: { ...structuredClone(configuration.runtime), capabilityRevision: null },
      mode: configuration.mode,
      isolation: configuration.isolation,
      repositoryWorkspaceId: null,
      savedRepositoryWorkspaceId: configuration.repositoryWorkspaceId,
      search: search.toString(),
    },
  };
}
