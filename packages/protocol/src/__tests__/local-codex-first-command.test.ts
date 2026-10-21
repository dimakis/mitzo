import { expect, it } from 'vitest';
import { LocalCodexFirstCommandSchema } from '../local-codex-first-command.js';
export const localCommand = {
  runOn: 'local',
  repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
  clientMsgId: 'first-local',
  capabilityRevision: 'capability-r1',
  runtime: {
    account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'profile-r1' },
    harness: 'codex',
    targetId: 'mac',
    mode: 'agent',
  },
  selection: {
    version: 1,
    agent: { profileId: 'agent', revision: 1 },
    model: 'luna-fixture',
    thinking: 'low',
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
  },
  payload: { text: 'Inspect the repository' },
};
it('preserves the exact bounded first-command choice', () => {
  expect(LocalCodexFirstCommandSchema.parse(localCommand)).toEqual(localCommand);
});
it.each([
  {
    ...localCommand.selection,
    agent: { profileId: 'mitzo-profile-builder', revision: 1, kind: 'builtin' },
  },
  { ...localCommand.selection, context: { source: 'workspace', revision: 'recipe-r1' } },
])('preserves namespace and recipe intent while server owners qualify authority', (selection) => {
  expect(LocalCodexFirstCommandSchema.parse({ ...localCommand, selection }).selection).toEqual(
    selection,
  );
});
it.each([
  { ...localCommand, sessionId: 'caller-session' },
  { ...localCommand, cwd: '/caller' },
  {
    ...localCommand,
    selection: {
      ...localCommand.selection,
      agent: { ...localCommand.selection.agent, kind: 'user' },
    },
  },
  { ...localCommand, payload: { text: 'x', systemPrompt: 'forged' } },
  {
    ...localCommand,
    selection: { ...localCommand.selection, permission: { mode: 'agent', revision: 1 } },
  },
  { ...localCommand, runtime: { ...localCommand.runtime, mode: 'ask' } },
  {
    ...localCommand,
    runtime: {
      ...localCommand.runtime,
      account: { ...localCommand.runtime.account, provider: 'google-vertex' },
    },
  },
])('rejects caller authority and incompatible first-command shape', (value) => {
  expect(LocalCodexFirstCommandSchema.safeParse(value).success).toBe(false);
});

it.each([
  { data: 'cG5n', mediaType: 'image/svg+xml' },
  { data: 'ab==', mediaType: 'image/png' },
  { data: 'not-base64!', mediaType: 'image/png' },
  { data: '', mediaType: 'image/png' },
])('rejects unsupported or noncanonical image input before admission', (image) => {
  expect(
    LocalCodexFirstCommandSchema.safeParse({
      ...localCommand,
      payload: { text: 'x', images: [image] },
    }).success,
  ).toBe(false);
});
it('accepts bounded canonical images without Node Buffer', () => {
  expect(
    LocalCodexFirstCommandSchema.safeParse({
      ...localCommand,
      payload: { text: 'x', images: [{ data: 'cG5n', mediaType: 'image/png' }] },
    }).success,
  ).toBe(true);
});
