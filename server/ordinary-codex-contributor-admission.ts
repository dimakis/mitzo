import type { AccountBinding, MitzoMode } from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';
import { openShellRuntimeConfig } from './openshell-runtime.js';

const unsupported = 'Selected account does not support ordinary contributor turns';

export class OrdinaryContributorModeError extends Error {
  constructor() {
    super('OpenShell contributors require Agent or Auto mode.');
    this.name = 'OrdinaryContributorModeError';
  }
}

/** Proves route compatibility only; startChat owns runtime creation and dispatch. */
export function assertOrdinaryCodexContributorAccount(
  accounts: AccountProfiles,
  binding: AccountBinding,
  mode?: MitzoMode,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    accounts.resume(binding);
    if (binding.provider === 'openai-codex') {
      if (accounts.codexProfile(binding).nativeAuth) throw new Error(unsupported);
      return;
    }
    if (
      binding.provider !== 'openai' ||
      env.MITZO_OPENSHELL_ENABLED !== '1' ||
      env.MITZO_OPENSHELL_SANDBOX_NAME ||
      env.MITZO_OPENSHELL_OPENAI_API_ENABLED === '0' ||
      !openShellRuntimeConfig(env) ||
      !accounts.apiProfile(binding).sandboxProvider
    )
      throw new Error(unsupported);
  } catch {
    // Account and host configuration diagnostics may contain private paths.
    throw new Error(unsupported);
  }
  if (mode === 'ask') throw new OrdinaryContributorModeError();
}
