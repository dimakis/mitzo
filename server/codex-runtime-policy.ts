import { z } from 'zod';
/** Constrained app-server configuration. Mitzo supplies executable tools dynamically.
 * Native skills readers remain available; restricted skill ceilings are rejected by the controller.
 */
export function codexRuntimeOverrides(
  configuration: unknown,
  workspaceId?: string,
): Record<string, unknown> {
  const parsed = z
    .object({
      mcp_servers: z.record(z.string(), z.unknown()).optional(),
      model_providers: z.record(z.string(), z.unknown()).optional(),
    })
    .safeParse(configuration);
  if (!parsed.success) throw new Error('Cannot inspect Codex runtime configuration');
  if (parsed.data.model_providers?.openai)
    throw new Error('Custom OpenAI routing is unsupported for the ChatGPT runtime');
  const config: Record<string, unknown> = { web_search: 'disabled', 'agents.enabled': false };
  if (workspaceId) config.forced_chatgpt_workspace_id = workspaceId;
  for (const feature of [
    'shell_tool',
    'unified_exec',
    'apps',
    'plugins',
    'browser_use',
    'computer_use',
    'image_generation',
    'view_image',
    'multi_agent',
    'hooks',
    'code_mode',
    'sleep_tool',
    'goals',
    'workspace_dependencies',
    'skill_mcp_dependency_install',
    'memories',
  ])
    config[`features.${feature}`] = false;
  // Code-mode-only models dispatch registered host tools through the JS wrapper.
  // This enables that dispatcher; native execution tools remain disabled above.
  config['features.code_mode_host'] = true;
  for (const name of Object.keys(parsed.data.mcp_servers ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      throw new Error('Unsupported inherited Codex MCP server name');
    config[`mcp_servers.${name}.enabled`] = false;
  }
  return config;
}
