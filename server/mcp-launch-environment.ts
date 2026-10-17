import {
  DEFAULT_INHERITED_ENV_VARS,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

export type McpLaunchEnvironment = Record<string, string | undefined>;

/** Match the SDK's safe inheritance and preserve absent names in a launch snapshot. */
export function snapshotMcpEnvironment(
  supplied: McpLaunchEnvironment,
  source: Record<string, string> = {},
): McpLaunchEnvironment {
  const inherited = getDefaultEnvironment();
  return {
    ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, inherited[name]])),
    ...supplied,
    ...source,
  };
}

export function mcpStdioEnvironment(
  supplied: McpLaunchEnvironment,
  source?: Record<string, string>,
): Record<string, string> {
  // The SDK spreads this object into Node's spawn environment. Explicit undefined
  // entries shadow newly inherited defaults and Node omits those variables. The
  // SDK declaration is narrower than Node's supported ProcessEnv representation.
  return snapshotMcpEnvironment(supplied, source) as Record<string, string>;
}
