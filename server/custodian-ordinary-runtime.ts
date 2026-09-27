import { openShellRuntimeConfig } from './openshell-runtime.js';

/** Ordinary chats cannot turn a missing controller sandbox configuration into
 * host credential execution. This does not configure or adopt the retained
 * Symposium gateway: only explicit ordinary runtime settings are accepted. */
export function requireCustodianOrdinaryRuntime(
  controller: boolean,
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!controller || !['openai', 'openai-codex'].includes(provider)) return;
  if (
    !openShellRuntimeConfig(env) ||
    env.MITZO_OPENSHELL_SANDBOX_NAME ||
    (provider === 'openai' && env.MITZO_OPENSHELL_OPENAI_API_ENABLED === '0')
  )
    throw Error(
      'Ordinary OpenAI chats in custodian mode require a dedicated OpenShell runtime; host fallback is unavailable',
    );
}
