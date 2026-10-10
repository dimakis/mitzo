import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resolveChatAgentProfile } from '../agent-library-binding.js';
import { EventStore } from '@mitzo/protocol/event-store';
import { V2SendMessage } from '@mitzo/protocol';
import { buildAgentProfilePrompt } from '../agent-library-prompt.js';
import { AgentProfileSelectionSchema } from '@mitzo/protocol';

const definition = {
  name: 'Bob',
  descriptor: 'The architect',
  role: 'agent',
  instructions: 'Challenge assumptions.',
  expectedOutput: 'Decision brief',
  acceptanceCriteria: ['Use evidence'],
  modelPolicyRole: 'agent',
};
const snapshot = {
  profileId: 'bob',
  revision: 3,
  definition,
  contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
};
afterEach(() => vi.restoreAllMocks());
it('accepts existing catalog IDs with spaces through selection, wire parsing and snapshot admission', async () => {
  const selected = { profileId: 'my agent', revision: 3 };
  expect(AgentProfileSelectionSchema.parse(selected)).toEqual(selected);
  expect(
    V2SendMessage.parse({
      type: 'send',
      sessionId: null,
      clientMsgId: 'message',
      prompt: 'hello',
      agentProfile: selected,
    }).agentProfile,
  ).toEqual(selected);
  expect(
    await resolveChatAgentProfile({
      requested: selected,
      lookup: async () => ({ ...snapshot, ...selected }),
    }),
  ).toEqual({ ...snapshot, ...selected });
});
it('pins the exact published profile and refuses a missing revision', async () => {
  const lookup = vi.fn(async () => snapshot);
  expect(
    await resolveChatAgentProfile({ requested: { profileId: 'bob', revision: 3 }, lookup }),
  ).toEqual(snapshot);
  expect(lookup).toHaveBeenCalledWith({ profileId: 'bob', revision: 3 });
  await expect(
    resolveChatAgentProfile({
      requested: { profileId: 'bob', revision: 4 },
      lookup: async () => null,
    }),
  ).rejects.toThrow(/not found/i);
});
it('resumes its saved snapshot without adopting an updated catalog definition', async () => {
  const lookup = vi.fn();
  expect(await resolveChatAgentProfile({ stored: snapshot, resume: true, lookup })).toEqual(
    snapshot,
  );
  expect(lookup).not.toHaveBeenCalled();
  await expect(
    resolveChatAgentProfile({
      stored: snapshot,
      resume: true,
      requested: { profileId: 'bob', revision: 4 },
      lookup,
    }),
  ).rejects.toThrow(/new chat/i);
});
it('validates snapshot identity, hash, and provider compatibility before execution', async () => {
  await expect(
    resolveChatAgentProfile({
      requested: { profileId: 'bob', revision: 3 },
      lookup: async () => ({ ...snapshot, profileId: 'other' }),
    }),
  ).rejects.toThrow(/identity/i);
  await expect(
    resolveChatAgentProfile({
      stored: { ...snapshot, contentHash: 'a'.repeat(64) },
      lookup: vi.fn(),
    }),
  ).rejects.toThrow(/hash/i);
  const recipe = {
    version: 1 as const,
    context: { include: [] as [], sources: [] as [] },
    skillRefs: [],
    toolDefaults: { mode: 'read-only' as const, preferredTools: [] },
    compatibleProviders: ['openai-codex' as const],
    reviewerTemplate: 'general' as const,
  };
  const withRecipe = { ...definition, recipe };
  await expect(
    resolveChatAgentProfile({
      requested: { profileId: 'bob', revision: 3 },
      lookup: async () => ({
        ...snapshot,
        definition: withRecipe,
        contentHash: createHash('sha256').update(JSON.stringify(withRecipe)).digest('hex'),
      }),
    }),
  ).rejects.toThrow(/explicit account/i);
  await expect(
    resolveChatAgentProfile({
      provider: 'openai',
      requested: { profileId: 'bob', revision: 3 },
      lookup: async () => ({
        ...snapshot,
        definition: withRecipe,
        contentHash: createHash('sha256').update(JSON.stringify(withRecipe)).digest('hex'),
      }),
    }),
  ).rejects.toThrow(/compatible/i);
});
it('preserves a profile snapshot independently of draft edits and session metadata updates', () => {
  const events = new EventStore(':memory:');
  try {
    events.upsertSession({ sessionId: 'chat-bob', agentProfile: snapshot });
    events.upsertSession({ sessionId: 'chat-bob', summary: 'Renamed chat' });
    expect(events.getSession('chat-bob')?.agentProfile).toEqual(snapshot);
    expect(() =>
      events.upsertSession({ sessionId: 'chat-bob', agentProfile: { ...snapshot, revision: 4 } }),
    ).toThrow(/immutable/i);
    expect(events.getSession('legacy')?.agentProfile).toBeUndefined();
    expect(
      buildAgentProfilePrompt(events.getSession('chat-bob')!.agentProfile!.definition),
    ).toContain('Bob · The architect');
  } finally {
    events.close();
  }
});
it('carries an exact profile selection on the wire without accepting a client-provided snapshot', () => {
  const message = V2SendMessage.parse({
    type: 'send',
    sessionId: null,
    clientMsgId: 'test',
    prompt: 'Hello',
    agentProfile: { profileId: 'bob', revision: 3 },
  });
  expect(message.agentProfile).toEqual({ profileId: 'bob', revision: 3 });
  expect(V2SendMessage.safeParse({ ...message, agentProfile: snapshot }).success).toBe(false);
});
