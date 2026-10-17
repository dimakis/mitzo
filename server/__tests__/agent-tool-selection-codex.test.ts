import { expect, it, vi } from 'vitest';

vi.mock('../agent-tool-catalog.js', () => ({
  agentToolCatalog: () => [
    {
      id: 'mitzo:Read',
      version: 1,
      name: 'Read',
      required: false,
      routes: ['local-api', 'codex', 'codex-owned-local'],
    },
    {
      id: 'mitzo:Write',
      version: 1,
      name: 'Write',
      required: false,
      routes: ['local-api', 'codex', 'codex-owned-local'],
    },
    {
      id: 'mitzo:AskUserQuestion',
      version: 1,
      name: 'AskUserQuestion',
      required: true,
      routes: ['local-api', 'codex', 'codex-owned-local'],
    },
  ],
}));
vi.mock('../agent-context-compiler.js', () => ({ contextDigest: () => 'digest' }));
vi.mock('../agent-library-transport.js', () => ({
  readBuiltinAgentLibraryProfile: () => null,
}));

import {
  agentToolAllowed,
  assertAgentToolRoute,
  bindAgentToolSelection,
  configuredMcpSourcesForAgentSelection,
  filterAgentTools,
} from '../agent-tool-selection.js';
import { ordinaryCodexAgentProfileRouteProjection } from '../ordinary-codex-agent-profile.js';

it('exposes only the published native Codex tools and established required tools', () => {
  const session = {};
  const definition = { tools: [{ id: 'mitzo:Read', version: 1 }] };

  expect(() => assertAgentToolRoute(definition as never, 'codex')).not.toThrow();
  bindAgentToolSelection(session, definition as never, 'codex');

  expect(
    filterAgentTools(
      session,
      ['Read', 'Write', 'AskUserQuestion'].map((name) => ({ name })),
    ),
  ).toEqual([{ name: 'Read' }, { name: 'AskUserQuestion' }]);
  expect(agentToolAllowed(session, 'Write')).toBe(false);
});

it('keeps an explicitly empty native Codex selection empty except for established required tools', () => {
  const session = {};
  const configured = { selected: { command: 'selected' }, unselected: { command: 'unselected' } };
  bindAgentToolSelection(session, { tools: [] } as never, 'codex');

  expect(
    filterAgentTools(
      session,
      ['Read', 'AskUserQuestion'].map((name) => ({ name })),
    ),
  ).toEqual([{ name: 'AskUserQuestion' }]);
  expect(configuredMcpSourcesForAgentSelection(session, configured)).toEqual({});
});

it('preserves legacy configured MCP discovery only when no explicit selection exists', () => {
  const session = {};
  const configured = { legacy: { command: 'legacy' } };

  expect(configuredMcpSourcesForAgentSelection(session, configured)).toBe(configured);
});

it('admits configured MCP and API receipts only on Codex routes with matching owners', () => {
  const mcp = { tools: [{ id: 'mcp:source:tool', version: 1, revision: 'receipt' }] } as never;
  expect(() => assertAgentToolRoute(mcp, 'codex')).not.toThrow();
  expect(() => assertAgentToolRoute(mcp, 'codex-owned-local')).not.toThrow();
  const api = { tools: [{ id: 'api:tool', version: 1, revision: 'receipt' }] } as never;
  expect(() => assertAgentToolRoute(api, 'codex')).not.toThrow();
  expect(() => assertAgentToolRoute(api, 'codex-owned-local')).toThrow(/unavailable/i);
  expect(() => assertAgentToolRoute({ tools: [] } as never, 'codex-openshell')).toThrow(
    /not supported on this runtime route/i,
  );
});

it('projects tool-selection capability only on its supported local Codex route', () => {
  const profile = {
    profileId: 'limited',
    revision: 1,
    definition: { tools: [{ id: 'mitzo:Read', version: 1 }] },
  };
  const policy = {
    contextRecipes: 'supported' as const,
    toolSelection: true,
    toolRoute: 'codex',
  };

  expect(
    ordinaryCodexAgentProfileRouteProjection(
      [profile] as never,
      'openai-codex',
      'local',
      undefined,
      policy,
    ).agentProfiles,
  ).toHaveLength(1);
  expect(
    ordinaryCodexAgentProfileRouteProjection(
      [profile] as never,
      'openai-codex',
      'openshell',
      undefined,
      policy,
    ).agentProfileRejections[0]?.reason,
  ).toBe('tool_selection_unavailable');
  const unsupported = {
    ...profile,
    definition: { tools: [{ id: 'api:tool', version: 1, revision: 'receipt' }] },
  };
  const ownedLocalPolicy = { ...policy, toolRoute: 'codex-owned-local' };
  expect(
    ordinaryCodexAgentProfileRouteProjection(
      [unsupported] as never,
      'openai-codex',
      'local',
      undefined,
      ownedLocalPolicy,
    ).agentProfileRejections[0]?.reason,
  ).toBe('tool_selection_unavailable');
});
