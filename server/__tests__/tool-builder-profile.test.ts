import { expect, it } from 'vitest';
import {
  PROFILE_BUILDER_ID,
  TOOL_BUILDER_ID,
  TOOL_BUILDER_REVISION,
  toolBuilderDefinition,
} from '@mitzo/protocol';
import { readBuiltinAgentLibraryProfile } from '../agent-library-transport.js';
import { agentToolAllowed, bindAgentToolSelection } from '../agent-tool-selection.js';
import { agentToolCatalog } from '../agent-tool-catalog.js';

it('defines a reusable Tool Builder profile with bounded review and publication guidance', () => {
  expect(toolBuilderDefinition.name).toBe('Tool Builder');
  expect(toolBuilderDefinition.instructions).toContain('ToolBuilderSearchCatalog');
  expect(toolBuilderDefinition.instructions).toContain('ToolBuilderPrepareDraft');
  expect(toolBuilderDefinition.instructions).toContain('ToolBuilderSubmitReview');
  expect(toolBuilderDefinition.instructions).toContain('never self-approve');
  expect(toolBuilderDefinition.instructions).toContain('Only statically installed implementations');
  expect(toolBuilderDefinition.tools).toEqual(
    expect.arrayContaining([
      { id: 'mitzo:ToolBuilderSearchCatalog', version: 1 },
      { id: 'mitzo:ToolBuilderReadContract', version: 1 },
      { id: 'mitzo:ToolBuilderPrepareDraft', version: 1 },
      { id: 'mitzo:ToolBuilderReviseDraft', version: 1 },
      { id: 'mitzo:ToolBuilderSubmitReview', version: 1 },
    ]),
  );
});

it('enrolls only the Tool Builder capabilities through existing local API selection', () => {
  const session = {};
  bindAgentToolSelection(session, toolBuilderDefinition);
  const catalog = agentToolCatalog();
  for (const name of [
    'ToolBuilderSearchCatalog',
    'ToolBuilderReadContract',
    'ToolBuilderPrepareDraft',
  ]) {
    expect(catalog.some((tool) => tool.id === `mitzo:${name}` && tool.version === 1)).toBe(true);
    expect(agentToolAllowed(session, name)).toBe(true);
  }
  expect(agentToolAllowed(session, 'Bash')).toBe(false);
});

it('resolves only the exact immutable built-in revision for each Builder profile', () => {
  const builder = readBuiltinAgentLibraryProfile({
    kind: 'builtin',
    profileId: TOOL_BUILDER_ID,
    revision: TOOL_BUILDER_REVISION,
  });
  expect(builder?.definition).toEqual(toolBuilderDefinition);
  expect(
    readBuiltinAgentLibraryProfile({
      kind: 'builtin',
      profileId: TOOL_BUILDER_ID,
      revision: TOOL_BUILDER_REVISION + 1,
    }),
  ).toBeNull();
  expect(
    readBuiltinAgentLibraryProfile({ kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: 2 }),
  ).toBeNull();
});
