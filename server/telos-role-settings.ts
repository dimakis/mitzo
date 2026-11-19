import type { OrdinaryWorkspaceSettings, TelosRepositoryChatSettings } from '@mitzo/protocol';
import type { RepositoryWorkspaces } from './repository-workspaces.js';

/** Role settings: an ordinary workspace (new or adopted Codex chat) or the
 * retained repository task of an adopted Local Mac Claude chat. Dependency-free
 * so canonical role review never loads execution or authentication owners. */
export type TelosRoleSettings = OrdinaryWorkspaceSettings | TelosRepositoryChatSettings;

/** Claude adopts through the same review; its engine still owns its tool route. */
export function telosRoleToolRoute(settings: TelosRoleSettings) {
  return settings.binding.harness.implementation === 'claude-sdk'
    ? ('claude-sdk' as const)
    : ('codex-owned-local' as const);
}
/** Ordinary preparation readiness applies to ordinary workspaces only. An adopted
 * repository-backed Claude chat is requalified by its custody observation. */
export async function qualifyTelosRoleWorkspace(
  workspaces: RepositoryWorkspaces,
  selected: Omit<
    Parameters<RepositoryWorkspaces['qualifyOrdinaryWorkspace']>[0],
    'preparationId' | 'settings' | 'signal'
  >,
  settings: TelosRoleSettings,
  signal: AbortSignal,
) {
  if (settings.workspace.kind === 'repository') return;
  const ordinary = settings as OrdinaryWorkspaceSettings;
  await workspaces.qualifyOrdinaryWorkspace({
    ...selected,
    preparationId: ordinary.workspace.preparationId,
    settings: ordinary,
    signal,
  });
}
