import type { AccountBinding, SessionRuntimeBinding } from '@mitzo/protocol';

/** Catalog availability is not proof that a retained execution can change settings. */
export function sessionModelSettingsReason(
  provider: AccountBinding['provider'] | undefined,
  harness: SessionRuntimeBinding['harness']['implementation'] | undefined,
  codexBacked: boolean,
): string | undefined {
  // Bound runtimes publish their own continuation capability and native constraints.
  if (harness) return undefined;
  if (provider === 'anthropic-vertex')
    return 'This older Agent SDK chat keeps its original model and thinking. Start a new chat to choose different settings.';
  if (provider === 'openai' && !codexBacked)
    return 'This older API chat is read-only. Use Continue with Codex to review a continuation with new settings.';
  return undefined;
}
