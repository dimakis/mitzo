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

it.each(['local', 'openshell'])(
  'accepts numerous screenshots and long text on %s, for first and later turns',
  async (runOn) => {
    const {
      OrdinaryCodexFirstCommandSchema,
      OrdinaryCodexContinuationCommandSchema,
      OrdinaryWorkspaceFirstCommandSchema,
    } = await import('../index.js');
    const payload = {
      text: 'Long message. '.repeat(100000),
      images: Array.from({ length: 30 }, () => ({
        data: 'AAAA'.repeat(16000),
        mediaType: 'image/png',
      })),
    };
    const command = { ...localCommand, runOn, payload };
    expect(OrdinaryCodexFirstCommandSchema.parse(command).payload).toEqual(payload);
    expect(
      OrdinaryCodexContinuationCommandSchema.parse({ ...command, sessionId: 'retained' }).payload,
    ).toEqual(payload);
    const { repositoryWorkspaceId, ...ordinary } = command;
    expect(
      OrdinaryWorkspaceFirstCommandSchema.parse({
        ...ordinary,
        version: 2,
        sessionId: 'prepared',
        workspace: { kind: 'ordinary', workspaceId: repositoryWorkspaceId },
      }).payload,
    ).toEqual(payload);
  },
);

it('accepts 100 pages and rejects attachment overflow without silently dropping any', () => {
  const image = { data: 'AAAA', mediaType: 'image/jpeg' };
  expect(
    LocalCodexFirstCommandSchema.parse({
      ...localCommand,
      payload: { text: 'Reports', images: Array(100).fill(image) },
    }).payload.images,
  ).toHaveLength(100);
  expect(
    LocalCodexFirstCommandSchema.safeParse({
      ...localCommand,
      payload: { text: 'Reports', images: Array(101).fill(image) },
    }).success,
  ).toBe(false);
});

it('keeps decoded attachment and UTF-8 text budgets independent of encoding overhead', async () => {
  const { ChatImagesSchema, ChatMessageTextSchema } = await import('../chat-input-limits.js');
  const oneMiB = { data: Buffer.alloc(1024 * 1024).toString('base64'), mediaType: 'image/png' };
  expect(ChatImagesSchema.safeParse(Array(64).fill(oneMiB)).success).toBe(true);
  expect(ChatImagesSchema.safeParse(Array(65).fill(oneMiB)).success).toBe(false);
  const oversized = { ...oneMiB, data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') };
  expect(ChatImagesSchema.safeParse([oversized]).success).toBe(false);
  expect(ChatMessageTextSchema.safeParse('x'.repeat(8 * 1024 * 1024)).success).toBe(true);
  expect(ChatMessageTextSchema.safeParse('😀'.repeat(2 * 1024 * 1024 + 1)).success).toBe(false);
});
