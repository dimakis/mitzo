import { expect, it } from 'vitest';
import { codexRuntimeOverrides } from '../codex-runtime-policy.js';
it('disables inherited MCP servers and native execution paths while keeping host tools separate', () => {
  const c = codexRuntimeOverrides({ mcp_servers: { work: { command: 'private-secret' } } });
  expect(c['mcp_servers.work.enabled']).toBe(false);
  for (const feature of [
    'shell_tool',
    'unified_exec',
    'apps',
    'plugins',
    'browser_use',
    'computer_use',
    'image_generation',
    'multi_agent',
    'hooks',
    'code_mode_host',
  ])
    expect(c[`features.${feature}`]).toBe(false);
  expect(c['agents.enabled']).toBe(false);
  expect(c.web_search).toBe('disabled');
  expect(JSON.stringify(c)).not.toContain('private-secret');
});
it('rejects custom OpenAI routing and unsupported configuration names rather than guessing', () => {
  expect(() =>
    codexRuntimeOverrides({
      model_providers: { openai: { base_url: 'https://alternate.invalid' } },
    }),
  ).toThrow('routing');
  expect(() => codexRuntimeOverrides({ mcp_servers: { 'ambiguous.name': {} } })).toThrow('MCP');
});
