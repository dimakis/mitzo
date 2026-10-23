import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { agentToolCatalog } from '../agent-tool-catalog.js';
import { credentialConnectionToolDefinitions } from '../credential-connection-tools.js';
import {
  assertAgentToolRoute,
  bindAgentToolSelection,
  agentToolAllowed,
} from '../agent-tool-selection.js';

it.each(['SearchPastSessions', 'ReadPastSession'])(
  'registers %s only as optional owned-local read capability',
  (name) => {
    expect(agentToolCatalog().find((tool) => tool.name === name)).toMatchObject({
      source: 'History',
      behavior: 'read',
      routes: ['codex-owned-local'],
      required: false,
    });
    const definition = { tools: [{ id: `mitzo:${name}`, version: 1 }] } as never;
    expect(() => assertAgentToolRoute(definition, 'codex-owned-local')).not.toThrow();
    for (const route of ['codex', 'local-api', 'openshell', 'claude-sdk'])
      expect(() => assertAgentToolRoute(definition, route)).toThrow();
  },
);

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
  for (const route of ['claude-sdk', 'openshell', 'symposium'])
    expect(() => assertAgentToolRoute({ tools: [] } as never, route)).toThrow(/not supported/i);
  expect(() => assertAgentToolRoute({ tools: [] } as never, 'codex')).not.toThrow();
  expect(() => assertAgentToolRoute({ tools: [] } as never, 'local-api')).not.toThrow();
  expect(() =>
    assertAgentToolRoute(
      { tools: [{ id: 'mitzo:GetConnectionGuide', version: 1 }] } as never,
      'codex',
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentToolRoute(
      { tools: [{ id: 'mitzo:GetConnectionGuide', version: 1 }] } as never,
      'codex-owned-local',
    ),
  ).toThrow(/unavailable/i);
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
  const fixture = JSON.parse(
    readFileSync(new URL('../../tests/fixtures/agent-tool-catalog.json', import.meta.url), 'utf8'),
  );
  expect(fixture).toEqual(agentToolCatalog());
});

it('registers task proposals separately from execution with explicit selection ceilings', () => {
  expect(agentToolCatalog().find((tool) => tool.name === 'AgentReadTasks')).toMatchObject({
    version: 1,
    behavior: 'read',
    routes: ['local-api', 'codex-owned-local'],
  });
  expect(agentToolCatalog().find((tool) => tool.name === 'AgentProposeTask')).toMatchObject({
    version: 1,
    behavior: 'write',
    routes: ['local-api', 'codex-owned-local'],
  });
  const session = {};
  bindAgentToolSelection(session, { tools: [] } as never);
  expect(agentToolAllowed(session, 'AgentReadTasks')).toBe(false);
  expect(agentToolAllowed(session, 'AgentProposeTask')).toBe(false);
});

it('does not qualify selected task tools on legacy host Codex or OpenShell', () => {
  const definition = { tools: [{ id: 'mitzo:AgentProposeTask', version: 1 }] } as never;
  expect(() => assertAgentToolRoute(definition, 'codex-owned-local')).not.toThrow();
  expect(() => assertAgentToolRoute(definition, 'codex')).toThrow(/unavailable/);
  expect(() => assertAgentToolRoute(definition, 'openshell')).toThrow(/not supported/);
});

it('limits the configured main merge tool to explicit owned native selection', () => {
  const ref = { id: 'mitzo:RequestGithubMainPublication', version: 1 };
  expect(() => assertAgentToolRoute({ tools: [ref] } as never, 'codex-owned-local')).not.toThrow();
  for (const route of ['local-api', 'codex', 'openshell', 'symposium'])
    expect(() => assertAgentToolRoute({ tools: [ref] } as never, route)).toThrow();
  const session = {};
  bindAgentToolSelection(session, { tools: [ref] } as never, 'codex-owned-local');
  expect(agentToolAllowed(session, 'RequestGithubMainPublication')).toBe(true);
  expect(agentToolAllowed(session, 'RequestGithubPublish')).toBe(false);
  expect(agentToolAllowed(session, 'TelosFindArtifacts')).toBe(false);
});

it.each(['TelosStartSlice', 'TelosWorkControl'])(
  'selects existing %s only on the owned local route without granting a role',
  (name) => {
    const definition = { tools: [{ id: `mitzo:${name}`, version: 1 }] } as never;
    expect(agentToolCatalog().find((entry) => entry.name === name)).toMatchObject({
      routes: ['codex-owned-local'],
      requirement: expect.stringContaining('current retained lead'),
    });
    expect(() => assertAgentToolRoute(definition, 'codex-owned-local')).not.toThrow();
    for (const route of ['local-api', 'codex', 'openshell', 'claude-sdk', 'symposium'])
      expect(() => assertAgentToolRoute(definition, route)).toThrow();
  },
);
