import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { agentToolCatalog } from './agent-tool-catalog.js';
import { SessionLaunchError } from './session-launch-store.js';

/** Legacy additional-tool intent can require an exposed tool, never widen a
 * published profile. Actual calls still use their ordinary approval owners. */
export function assertSessionLaunchTools(
  names: readonly string[],
  definition: SymposiumProfileDefinition,
) {
  if (!names.length) return;
  const catalog = agentToolCatalog();
  for (const name of names) {
    const tool = catalog.find((entry) => entry.name === name);
    if (!tool?.routes.includes('codex-owned-local'))
      throw new SessionLaunchError(
        `Additional tool ${name} is unavailable for Local Mac Codex. Review the tool selection.`,
      );
    if (
      definition.tools !== undefined &&
      !tool.required &&
      !definition.tools.some((ref) => ref.id === tool.id && ref.version === tool.version)
    )
      throw new SessionLaunchError(
        `Additional tool ${name} is not selected by this agent profile. Choose a profile that includes it.`,
      );
  }
}
