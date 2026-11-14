/** Exact ordinary SDK callback allowlist, shared by its owner and read-only
 * support projection. These names grant nothing and do not change profile
 * eligibility in the executable catalog.
 */
export const SDK_CONNECTION_PREFIX = 'mcp__mitzo-connections__';
const connectionHelpers: readonly string[] = Object.freeze([
  ...nativeConnectionToolNames,
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
  return connectionHelpers.includes(name) ? `${SDK_CONNECTION_PREFIX}${name}` : undefined;
}
import { nativeConnectionToolNames } from './credential-connection-tools.js';
