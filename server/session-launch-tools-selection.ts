import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { SessionLaunchError } from './session-launch-store.js';

/** Legacy additional-tool intent can require an exposed tool, never widen a
 * published profile. Actual calls still use their ordinary approval owners. */
export async function assertSessionLaunchTools(
  names: readonly string[],
  definition: SymposiumProfileDefinition,
) {
  if (!names.length) return;
  const { agentToolCatalog } = await import('./agent-tool-catalog.js');
  const catalog = agentToolCatalog();
  const [
    { telosWorkDefinitions },
    { telosWorkControlDefinitions },
    { telosItemDefinitions },
    { githubMainPublicationTool },
    { ordinaryNativeTelosArtifactTools },
    { telosSessionLaunchDefinition },
    { bindAgentToolSelection, nativeExecutionToolsAllowed },
  ] = await Promise.all([
    import('./telos-work-tools.js'),
    import('./telos-work-control-tools.js'),
    import('./telos-item-tools.js'),
    import('./telos-main-publication.js'),
    import('./telos-artifact-tools.js'),
    import('./telos-session-launch-tool.js'),
    import('./agent-tool-selection.js'),
  ]);
  // StartSession allocates an ordinary chat without a retained Telos role.
  // Use the native role-gated registrations, not names from caller input or
  // profile membership, to reject requirements it cannot expose at admission.
  const roleTools = new Set(
    [
      ...telosWorkDefinitions,
      ...telosWorkControlDefinitions,
      ...telosItemDefinitions,
      githubMainPublicationTool,
      telosSessionLaunchDefinition,
    ].map((tool) => tool.name),
  );
  const artifactNames = new Set(ordinaryNativeTelosArtifactTools(true).map((tool) => tool.name));
  const exposedArtifacts = new Set(
    ordinaryNativeTelosArtifactTools(definition.tools !== undefined).map((tool) => tool.name),
  );
  const selectedProfile = {};
  bindAgentToolSelection(selectedProfile, definition, 'codex-owned-local');
  for (const name of names) {
    if (roleTools.has(name))
      throw new SessionLaunchError(
        `Additional tool ${name} requires a retained Telos role. Use reviewed Telos role setup; a new ordinary chat cannot inherit that role.`,
      );
    const tool = catalog.find((entry) => entry.name === name);
    if (!tool?.routes.includes('codex-owned-local'))
      throw new SessionLaunchError(
        `Additional tool ${name} is unavailable for Local Mac Codex. Review the tool selection.`,
      );
    if (artifactNames.has(name) && !exposedArtifacts.has(name))
      throw new SessionLaunchError(
        `Additional tool ${name} requires an explicitly selected native tool profile. Choose a profile that exposes it.`,
      );
    if (
      definition.tools !== undefined &&
      !tool.required &&
      !definition.tools.some((ref) => ref.id === tool.id && ref.version === tool.version)
    )
      throw new SessionLaunchError(
        `Additional tool ${name} is not selected by this agent profile. Choose a profile that includes it.`,
      );
    if (tool.source === 'Local repositories' && !nativeExecutionToolsAllowed(selectedProfile))
      throw new SessionLaunchError(
        `Additional tool ${name} requires Bash, Read, Write and Edit in the selected native tool profile. Choose a profile that exposes them.`,
      );
  }
}
