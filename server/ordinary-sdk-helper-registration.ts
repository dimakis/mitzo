/** Exact ordinary SDK callback allowlist, shared by its owner and read-only
 * support projection. These names grant nothing and do not change profile
 * eligibility in the executable catalog.
 */
import { telosSdkToolNames, telosSdkPrefix } from './telos-sdk-definitions.js';
export const SDK_CONNECTION_PREFIX = 'mcp__mitzo-connections__';
export const ordinarySdkTelosTools = telosSdkToolNames.map((name) => telosSdkPrefix + name);
const connectionHelpers: readonly string[] = Object.freeze([
  'ListConnections',
  'SymposiumReadProfiles',
  'SymposiumConsult',
  'SymposiumProposeProfile',
  'AgentCommunication',
  'TelosCreateSession',
  'CaptureMemoryCandidate',
]);
export const ordinarySdkConnectionHelperTools: readonly string[] = Object.freeze(
  connectionHelpers.map((name) => `${SDK_CONNECTION_PREFIX}${name}`),
);

/** The SDK wire name and the inner skill-policy identity can differ. */
export function ordinarySdkHelperPolicyName(name: string): string | undefined {
  if (name === 'AskUserQuestion' || name === 'RequestWebAccess') return name;
  if (telosSdkToolNames.includes(name)) return telosSdkPrefix + name;
  return connectionHelpers.includes(name) ? `${SDK_CONNECTION_PREFIX}${name}` : undefined;
}
