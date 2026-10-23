/** Supported engine for new work. Accounts own authentication/billing; execution
 * targets own placement. Neither changes which engine a provider requires.
 * This is policy, not runtime availability or gateway qualification evidence.
 */
export function sessionHarnessForProvider(provider: string): 'codex' | 'claude-sdk' | 'gemini' {
  switch (provider) {
    case 'openai':
    case 'openai-codex':
      return 'codex';
    case 'anthropic-vertex':
      return 'claude-sdk';
    case 'google-vertex':
      // Native Gemini replacement is deferred; preserve its existing engine.
      return 'gemini';
    default:
      throw Error('Supported session harness unavailable');
  }
}
