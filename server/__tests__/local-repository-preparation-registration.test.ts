import { expect, it } from 'vitest';
import { z } from 'zod';
import { agentToolCatalog } from '../agent-tool-catalog.js';
import {
  agentToolAllowed,
  assertAgentToolRoute,
  bindAgentToolSelection,
} from '../agent-tool-selection.js';
import * as authorization from '../local-repository-preparation-authorization.js';
import { parseLocalRepositoryPreparationInput } from '../local-repository-preparation-input.js';
import { codexToolFailureResult } from '../codex-tool-failure.js';

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
  expect(localRepositoryPreparationDefinition.input_schema).toEqual({
    ...z.toJSONSchema(original, { io: 'input' }),
    oneOf: [{ required: ['path'] }, { required: ['source'] }],
  });
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
it.each([
  {},
  { path: '/private/SECRET', source: { kind: 'new', name: 'my-project' } },
  { source: { kind: 'new', name: '../SECRET' } },
  { path: 'relative/SECRET' },
  { source: { kind: 'new' }, destination: '/private/SECRET' },
  { source: { kind: 'new' }, context: { approval: 'SECRET' } },
])('returns a safe correction for malformed repository input %j before effects', (input) => {
  let error: unknown;
  try {
    parseLocalRepositoryPreparationInput(input);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  const result = codexToolFailureResult(error, false);
  expect(JSON.parse(result.content)).toMatchObject({
    error: 'invalid_input',
    diagnostic: {
      stage: 'repository_preparation',
      reason: 'invalid_input',
      effectStatus: 'not_started',
    },
    action: expect.stringContaining('exactly one'),
    retry: 'after_correction',
  });
  expect(result.content).toContain('destination');
  expect(result.content).toContain('source');
  expect(result.content).not.toContain('SECRET');
});
it.each([
  { path: '/absolute/existing-repo' },
  { source: { kind: 'existing', path: '/absolute/existing-repo' } },
  { source: { kind: 'clone', url: 'https://example.invalid/team/repo.git' } },
  { source: { kind: 'new', name: 'my-project' } },
])('accepts documented repository selectors %j with the existing default base', (input) => {
  expect(parseLocalRepositoryPreparationInput(input)).toEqual({
    ...input,
    base: { kind: 'default' },
  });
});
it('publishes executable examples and explains that task locations are assigned', async () => {
  const { localRepositoryPreparationDefinition, LOCAL_REPOSITORY_PREPARATION_INSTRUCTIONS } =
    await import('../local-repository-preparation-tool.js');
  const schema = localRepositoryPreparationDefinition.input_schema;
  expect(schema.required ?? []).not.toContain('base');
  expect(schema.examples).toHaveLength(3);
  for (const example of schema.examples as unknown[])
    expect(() => parseLocalRepositoryPreparationInput(example)).not.toThrow();
  expect(LOCAL_REPOSITORY_PREPARATION_INSTRUCTIONS).toContain('not a destination');
  expect(LOCAL_REPOSITORY_PREPARATION_INSTRUCTIONS).toContain('Do not promise');
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
