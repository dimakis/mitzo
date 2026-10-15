import { expect, it } from 'vitest';
import { agentToolCatalog } from '../agent-tool-catalog.js';
import { credentialConnectionToolDefinitions } from '../credential-connection-tools.js';
import {
  assertAgentToolRoute,
  bindAgentToolSelection,
  agentToolAllowed,
} from '../agent-tool-selection.js';

it('derives descriptions from real registrations and separates required tools from optional refs', () => {
  const catalog = agentToolCatalog();
  for (const tool of credentialConnectionToolDefinitions)
    expect(catalog.find((entry) => entry.id === `mitzo:${tool.name}`)).toMatchObject({
      name: tool.name,
      description: tool.description,
      version: 1,
      required: false,
    });
  expect(catalog.find((entry) => entry.name === 'AskUserQuestion')?.required).toBe(true);
  expect(new Set(catalog.map((entry) => entry.id)).size).toBe(catalog.length);
  expect(catalog.find((entry) => entry.name === 'ConnectionRequest')?.requirement).toMatch(
    /connection/i,
  );
});
it('denies wrappers and aliases by exact identity and captures selection once', () => {
  const session = {};
  bindAgentToolSelection(session, {
    tools: [{ id: 'mitzo:GetConnectionGuide', version: 1 }],
  } as never);
  expect(agentToolAllowed(session, 'GetConnectionGuide')).toBe(true);
  expect(agentToolAllowed(session, 'mcp__mitzo-connections__GetConnectionGuide')).toBe(true);
  for (const name of [
    'ConnectionRequest',
    'mcp__mitzo-connections__ConnectionRequest',
    'mitzo_mcp_forged',
    'mcp__other__GetConnectionGuide',
    'ExecuteProviderCapability',
    'RequestGithubPublish',
  ])
    expect(agentToolAllowed(session, name)).toBe(false);
  expect(agentToolAllowed(session, 'AskUserQuestion')).toBe(true);
  expect(() => bindAgentToolSelection(session, { tools: [] } as never)).toThrow(/immutable/i);
});
it('keeps legacy behavior but blocks explicit selections on unsupported routes and unknown versions', () => {
  expect(() => assertAgentToolRoute(undefined, 'claude-sdk')).not.toThrow();
  for (const route of ['claude-sdk', 'codex', 'openshell', 'symposium'])
    expect(() => assertAgentToolRoute({ tools: [] } as never, route)).toThrow(/not supported/i);
  expect(() => assertAgentToolRoute({ tools: [] } as never, 'local-api')).not.toThrow();
  expect(() =>
    assertAgentToolRoute({ tools: [{ id: 'mitzo:Read', version: 2 }] } as never, 'local-api'),
  ).toThrow(/unavailable/i);
  expect(() =>
    assertAgentToolRoute({ tools: [{ id: 'mitzo:Unknown', version: 1 }] } as never, 'local-api'),
  ).toThrow(/unavailable/i);
});

it('refuses missing connection dependencies before exposing an unusable selected operation', async () => {
  const { assertAgentToolAvailability } = await import('../agent-tool-selection.js');
  const runtime = await import('../credential-connections-runtime.js');
  const current = runtime.getCredentialConnectionsRuntime();
  runtime.setCredentialConnectionsRuntime(null);
  try {
    expect(() =>
      assertAgentToolAvailability(
        {
          tools: [
            { id: 'mitzo:ConnectionRequest', version: 1 },
            { id: 'mitzo:RequestConnectionAccess', version: 1 },
          ],
        } as never,
        'chat',
      ),
    ).toThrow(/active connection/i);
    expect(() =>
      assertAgentToolAvailability(
        { tools: [{ id: 'mitzo:GetConnectionGuide', version: 1 }] } as never,
        'chat',
      ),
    ).not.toThrow();
  } finally {
    runtime.setCredentialConnectionsRuntime(current);
  }
});

it('keeps the offline browser inventory aligned with authoritative registrations', async () => {
  const { default: fixture } = await import('../../tests/fixtures/agent-tool-catalog.json');
  expect(fixture).toEqual(agentToolCatalog());
});
