import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SymposiumProfileProposalStore } from '../symposium-profile-proposals.js';
import { SymposiumProfileStore } from '../symposium-profiles.js';
import {
  proposeProfileFromTool,
  symposiumProposeProfileDefinition,
} from '../symposium-profile-tool.js';

let directory: string;
let proposals: SymposiumProfileProposalStore;
let profiles: SymposiumProfileStore;
const definition = {
  name: 'Build Agent',
  role: 'coder' as const,
  instructions: 'Implement reviewed changes and explain the checks.',
  expectedOutput: 'A reviewable patch',
  acceptanceCriteria: ['Focused checks pass'],
  modelPolicyRole: 'coder',
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-profile-proposals-'));
  const dbPath = join(directory, 'events.db');
  proposals = new SymposiumProfileProposalStore(dbPath);
  profiles = new SymposiumProfileStore(dbPath);
});
afterEach(() => {
  proposals.close();
  profiles.close();
  rmSync(directory, { recursive: true, force: true });
});

it('registers a structured host tool with no save capability', () => {
  expect(symposiumProposeProfileDefinition.name).toBe('SymposiumProposeProfile');
  expect(JSON.stringify(symposiumProposeProfileDefinition.input_schema)).not.toContain('owner');
  expect(JSON.stringify(symposiumProposeProfileDefinition.input_schema)).not.toContain('sessionId');
});

it('keeps model drafts owner/session scoped and idempotent without saving a profile', () => {
  const input = { suggestedProfileId: 'build-agent', definition };
  const first = proposeProfileFromTool({
    store: proposals,
    owner: 'user',
    sessionId: 'chat',
    turnId: 'turn-1',
    callId: 'call-1',
    arguments: input,
  });
  const retry = proposeProfileFromTool({
    store: proposals,
    owner: 'user',
    sessionId: 'chat',
    turnId: 'turn-1',
    callId: 'call-1',
    arguments: input,
  });
  expect(retry.proposalId).toBe(first.proposalId);
  expect(profiles.list('user')).toEqual([]);
  expect(proposals.listPending('user', 'chat')).toHaveLength(1);
  expect(proposals.listPending('other', 'chat')).toEqual([]);
  expect(proposals.listPending('user', 'other-chat')).toEqual([]);
  expect(() =>
    proposeProfileFromTool({
      store: proposals,
      owner: 'user',
      sessionId: 'chat',
      turnId: 'turn-1',
      callId: 'call-1',
      arguments: {
        ...input,
        definition: {
          ...definition,
          name: 'Changed after retry',
        },
      },
    }),
  ).toThrow(/idempotency/i);
});

it('requires an explicit save, persists edited portable guidance, and fences discard', () => {
  const draft = proposals.propose('user', 'chat', 'call-1', { definition });
  expect(() =>
    proposals.save('other', 'chat', draft.proposalId, {
      profileId: 'build-agent',
      expectedRevision: 0,
      definition,
    }),
  ).toThrow(/not found/i);
  const saved = proposals.save('user', 'chat', draft.proposalId, {
    profileId: 'build-agent',
    expectedRevision: 0,
    definition: { ...definition, expectedOutput: 'A tested, reviewable patch' },
  });
  expect(saved.revision).toBe(1);
  expect(profiles.get('user', 'build-agent', 1)?.definition.expectedOutput).toBe(
    'A tested, reviewable patch',
  );
  expect(proposals.listPending('user', 'chat')).toEqual([]);
  expect(() => proposals.discard('user', 'chat', draft.proposalId)).toThrow(/saved/i);
  expect(
    proposals.save('user', 'chat', draft.proposalId, {
      profileId: 'build-agent',
      expectedRevision: 0,
      definition: { ...definition, expectedOutput: 'A tested, reviewable patch' },
    }).revision,
  ).toBe(1);
  expect(() =>
    proposals.save('user', 'chat', draft.proposalId, {
      profileId: 'build-agent',
      expectedRevision: 0,
      definition,
    }),
  ).toThrow(/conflicting/i);
});

it('serializes save and discard across two stores sharing a durable database', () => {
  const second = new SymposiumProfileProposalStore(join(directory, 'events.db'));
  try {
    const discarded = proposals.propose('user', 'chat', 'discard-first', { definition });
    second.discard('user', 'chat', discarded.proposalId);
    expect(() =>
      proposals.save('user', 'chat', discarded.proposalId, {
        profileId: 'discarded',
        expectedRevision: 0,
        definition,
      }),
    ).toThrow(/discarded/i);
    expect(profiles.get('user', 'discarded')).toBeNull();

    const savedDraft = second.propose('user', 'chat', 'save-first', { definition });
    proposals.save('user', 'chat', savedDraft.proposalId, {
      profileId: 'saved',
      expectedRevision: 0,
      definition,
    });
    expect(() => second.discard('user', 'chat', savedDraft.proposalId)).toThrow(/saved/i);
    expect(profiles.get('user', 'saved')?.revision).toBe(1);
  } finally {
    second.close();
  }
});

it('discards drafts without writing profiles and refuses private material or grants', () => {
  const draft = proposals.propose('user', 'chat', 'call-1', { definition });
  proposals.discard('user', 'chat', draft.proposalId);
  expect(() =>
    proposals.save('user', 'chat', draft.proposalId, {
      profileId: 'build-agent',
      expectedRevision: 0,
      definition,
    }),
  ).toThrow(/discarded/i);
  expect(profiles.list('user')).toEqual([]);
  for (const instructions of [
    'Read /Users/person/private/session.json',
    'Bearer abcdefghijklmnop',
    '[conversation transcript] first prompt',
  ])
    expect(() =>
      proposals.propose('user', 'chat', `call-${instructions}`, {
        definition: { ...definition, instructions },
      }),
    ).toThrow(/portable profiles cannot/i);
  expect(() =>
    proposals.propose('user', 'chat', 'grants', {
      definition: { ...definition, authorityGrant: { grantId: 'forged' } },
    } as never),
  ).toThrow();
  expect(
    proposals.propose('user', 'chat', 'normal-example', {
      definition: { ...definition, instructions: 'If a User: asks for a patch, explain it.' },
    }).state,
  ).toBe('pending');
});
