import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../src/event-store.js';
import { AgentContextSnapshotSchema } from '../src/index.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recipe = {
  version: 1 as const,
  source: 'workspace' as const,
  files: ['README.md'],
  tokenBudget: 256,
  required: [],
  excluded: [],
};
const definition = {
  name: 'Bob',
  role: 'agent',
  instructions: 'Challenge assumptions.',
  expectedOutput: 'Decision brief',
  acceptanceCriteria: ['Use evidence'],
  modelPolicyRole: 'agent',
  contextRecipe: recipe,
};
const profile = { profileId: 'bob', revision: 3, definition, contentHash: hash(definition) };
const context = {
  type: 'boot_context' as const,
  source: 'contexgin' as const,
  sourceCount: 1,
  tokenCount: 5,
  tokenBudget: 256,
  sources: [{ path: 'README.md', kind: 'reference' }],
  included: [],
  trimmed: [],
  fullMarkdown: '# Selected context',
};
const snapshot = {
  source: 'workspace' as const,
  compilerRevision: 'fixture-compiler-v1',
  recipeHash: hash(recipe),
  payloadHash: hash(context),
  workspaceIdentity: 'f'.repeat(64),
  context,
  profileId: 'bob',
  revision: 3,
  profileHash: profile.contentHash,
};
const stores: EventStore[] = [];
const roots: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function store(path = ':memory:') {
  const result = new EventStore(path);
  stores.push(result);
  return result;
}

it('pins compiled context with its profile and preserves it across restart and metadata edits', () => {
  expect(AgentContextSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  const root = mkdtempSync(join(tmpdir(), 'mitzo-agent-context-store-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const first = store(path);
  first.upsertSession({ sessionId: 'chat', agentProfile: profile, agentContext: snapshot });
  first.upsertSession({ sessionId: 'chat', summary: 'Renamed' });
  expect(first.getSession('chat')?.agentContext).toEqual(snapshot);
  first.close();
  stores.splice(stores.indexOf(first), 1);
  const resumed = store(path);
  expect(resumed.getSession('chat')?.agentContext).toEqual(snapshot);
  resumed.upsertSession({ sessionId: 'chat', agentContext: snapshot });
});
it('keeps legacy sessions unchanged and permits first-use compilation of an existing profile binding', () => {
  const events = store();
  events.upsertSession({ sessionId: 'legacy' });
  expect(events.getSession('legacy')?.agentContext).toBeUndefined();
  events.upsertSession({ sessionId: 'chat', agentProfile: profile });
  events.upsertSession({ sessionId: 'chat', agentContext: snapshot });
  expect(events.getSession('chat')?.agentContext).toEqual(snapshot);
});
it('refuses replacement or clearing of a pinned context and does not partially update metadata', () => {
  const events = store();
  events.upsertSession({
    sessionId: 'chat',
    summary: 'Keep',
    agentProfile: profile,
    agentContext: snapshot,
  });
  const changedContext = { ...context, fullMarkdown: 'Another payload' };
  expect(() =>
    events.upsertSession({
      sessionId: 'chat',
      summary: 'Wrong',
      agentContext: { ...snapshot, context: changedContext, payloadHash: hash(changedContext) },
    }),
  ).toThrow(/immutable/);
  expect(() => events.upsertSession({ sessionId: 'chat', agentContext: null as never })).toThrow();
  expect(events.getSession('chat')?.summary).toBe('Keep');
  expect(events.getSession('chat')?.agentContext).toEqual(snapshot);
});
it('rejects orphaned, mismatched, or corrupted context before creating a session', () => {
  const events = store();
  for (const binding of [
    { agentContext: snapshot },
    { agentProfile: profile, agentContext: { ...snapshot, profileId: 'other' } },
    { agentProfile: profile, agentContext: { ...snapshot, revision: 4 } },
    { agentProfile: profile, agentContext: { ...snapshot, profileHash: 'a'.repeat(64) } },
    { agentProfile: profile, agentContext: { ...snapshot, recipeHash: 'a'.repeat(64) } },
    { agentProfile: profile, agentContext: { ...snapshot, payloadHash: 'a'.repeat(64) } },
  ]) {
    expect(() => events.upsertSession({ sessionId: 'invalid', ...binding })).toThrow();
    expect(events.getSession('invalid')).toBeNull();
  }
});
