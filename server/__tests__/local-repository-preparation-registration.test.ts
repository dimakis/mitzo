import { expect, it } from 'vitest';
import { z } from 'zod';
import { agentToolCatalog } from '../agent-tool-catalog.js';
import {
  agentToolAllowed,
  assertAgentToolRoute,
  bindAgentToolSelection,
} from '../agent-tool-selection.js';
import * as authorization from '../local-repository-preparation-authorization.js';

it('publishes Prepare as an optional owned-local write requiring original scoped approval, independently of read tools', () => {
  const tool = agentToolCatalog().find((entry) => entry.name === 'PrepareLocalRepository');
  expect(tool).toMatchObject({
    id: 'mitzo:PrepareLocalRepository',
    version: 1,
    source: 'Local repositories',
    behavior: 'write',
    routes: ['codex-owned-local'],
    required: false,
  });
  expect(tool?.requirement).toMatch(/approv/i);
  for (const name of ['DiscoverLocalRepository', 'InspectLocalRepository'])
    expect(agentToolCatalog().find((entry) => entry.name === name)).toMatchObject({
      behavior: 'read',
    });
});
it('uses the ORIGINAL authorization decoder for its public definition without adding owner/signal/deadline fields', async () => {
  const { localRepositoryPreparationDefinition } =
    await import('../local-repository-preparation-tool.js');
  const original = Reflect.get(authorization, 'inputSchema') as z.ZodType;
  expect(localRepositoryPreparationDefinition.input_schema).toEqual(z.toJSONSchema(original));
  expect(original.safeParse({ path: '/private/tmp/source' }).success).toBe(true);
  for (const value of [
    { path: 'relative' },
    { path: '/source', deadline: Date.now() + 300000 },
    { path: '/source', context: {} },
    { path: '/source', approval: 'allow' },
    { path: '/source', nativeTarget: {} },
  ])
    expect(original.safeParse(value).success).toBe(false);
});
it('retains explicit profile exclusion and legacy admission without making Prepare available on other routes', () => {
  const selected = { tools: [{ id: 'mitzo:PrepareLocalRepository', version: 1 }] } as never;
  expect(() => assertAgentToolRoute(selected, 'codex-owned-local')).not.toThrow();
  for (const route of ['local-api', 'codex', 'openshell', 'claude-sdk'])
    expect(() => assertAgentToolRoute(selected, route)).toThrow();
  const include = {},
    exclude = {},
    legacy = {};
  bindAgentToolSelection(include, selected, 'codex-owned-local');
  bindAgentToolSelection(
    exclude,
    { tools: [{ id: 'mitzo:Read', version: 1 }] } as never,
    'codex-owned-local',
  );
  bindAgentToolSelection(legacy, undefined, 'codex-owned-local');
  expect(agentToolAllowed(include, 'PrepareLocalRepository')).toBe(true);
  expect(agentToolAllowed(exclude, 'PrepareLocalRepository')).toBe(false);
  expect(agentToolAllowed(legacy, 'PrepareLocalRepository')).toBe(true);
});
