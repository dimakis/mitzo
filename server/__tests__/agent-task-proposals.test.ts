import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumProfileProposalStore } from '../symposium-profile-proposals.js';
import { SymposiumProfileStore } from '../symposium-profiles.js';
import { AgentTaskStore } from '../agent-task-store.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
it('retains review proposals, exact task revisions and durable save receipts without allocating work', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-proposals-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const profiles = new SymposiumProfileStore(path);
  const profile = profiles.save('user', {
    profileId: 'trace',
    expectedRevision: 0,
    idempotencyKey: 'profile',
    definition: {
      name: 'Trace',
      role: 'agent',
      instructions: 'Diagnose',
      expectedOutput: 'Evidence',
      acceptanceCriteria: ['Cite'],
      modelPolicyRole: 'agent',
    },
  });
  profiles.close();
  let proposals = new SymposiumProfileProposalStore(path);
  let tasks = new AgentTaskStore(path);
  const definition = {
    name: 'Daily',
    objective: '',
    profile: {
      profileId: profile.profileId,
      revision: profile.revision,
      contentHash: profile.contentHash,
    },
    execution: null,
    workspace: null,
    schedule: { cron: '0 9 * * *', timezone: 'Europe/Dublin', state: 'paused' },
    notificationPolicy: 'results',
    outputPolicy: 'session',
  };
  const input = { taskId: 'daily', expectedRevision: 0, definition };
  try {
    const draft = proposals.proposeTask('user', 'chat', 'verified-call', input);
    expect(proposals.proposeTask('user', 'chat', 'verified-call', input)).toEqual(draft);
    expect(() =>
      proposals.proposeTask('user', 'chat', 'verified-call', {
        ...input,
        definition: { ...definition, name: 'Changed' },
      }),
    ).toThrow(/conflict/i);
    expect(tasks.list('user')).toEqual([]);
    expect(proposals.listTaskProposals('other', 'chat')).toEqual([]);
    expect(proposals.listTaskProposals('user', 'other')).toEqual([]);
    const saved = proposals.saveTask('user', 'chat', draft.proposalId, input);
    expect(saved).toMatchObject({
      taskId: 'daily',
      revision: 1,
      configuration: { state: 'draft' },
      definition,
    });
    expect(proposals.listTaskProposals('user', 'chat')[0]).toMatchObject({
      state: 'saved',
      savedTask: saved,
    });
    tasks.save('user', {
      ...input,
      expectedRevision: 1,
      idempotencyKey: 'later',
      definition: { ...definition, name: 'Later' },
    });
    expect(proposals.saveTask('user', 'chat', draft.proposalId, input)).toEqual(saved);
    expect(() =>
      proposals.saveTask('user', 'chat', draft.proposalId, {
        ...input,
        definition: { ...definition, name: 'Changed' },
      }),
    ).toThrow(/conflict/i);
    proposals.close();
    tasks.close();
    proposals = new SymposiumProfileProposalStore(path);
    tasks = new AgentTaskStore(path);
    expect(proposals.saveTask('user', 'chat', draft.proposalId, input)).toEqual(saved);
    const stale = proposals.proposeTask('user', 'chat', 'next-call', {
      ...input,
      expectedRevision: 1,
    });
    expect(() =>
      proposals.saveTask('user', 'chat', stale.proposalId, { ...input, expectedRevision: 1 }),
    ).toThrow(/conflict/i);
    expect(tasks.get('user', 'daily')?.revision).toBe(2);
    expect(
      proposals.listTaskProposals('user', 'chat').find((row) => row.proposalId === stale.proposalId)
        ?.state,
    ).toBe('pending');
    const bad = proposals.proposeTask('user', 'chat', 'bad-pin', {
      ...input,
      taskId: 'bad',
      definition: {
        ...definition,
        profile: { ...definition.profile, contentHash: 'b'.repeat(64) },
      },
    });
    expect(() =>
      proposals.saveTask('user', 'chat', bad.proposalId, {
        ...input,
        taskId: 'bad',
        definition: bad.definition,
      }),
    ).toThrow(/hash conflict/i);
    expect(tasks.get('user', 'bad')).toBeNull();
  } finally {
    proposals.close();
    tasks.close();
  }
});

it('does not initialize a task store during proposal construction and rolls task writes back with proposal receipt failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-proposal-atomic-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const proposals = new SymposiumProfileProposalStore(path);
  const db = new Database(path);
  try {
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_task_%'")
        .all(),
    ).toEqual([]);
    const profiles = new SymposiumProfileStore(path);
    const profile = profiles.save('user', {
      profileId: 'trace',
      expectedRevision: 0,
      idempotencyKey: 'profile',
      definition: {
        name: 'Trace',
        role: 'agent',
        instructions: 'Diagnose',
        expectedOutput: 'Evidence',
        acceptanceCriteria: ['Cite'],
        modelPolicyRole: 'agent',
      },
    });
    profiles.close();
    const input = {
      taskId: 'atomic',
      expectedRevision: 0,
      definition: {
        name: 'Atomic',
        objective: 'Review',
        profile: { profileId: profile.profileId, revision: 1, contentHash: profile.contentHash },
        execution: {
          account: {
            accountId: 'personal',
            provider: 'openai-codex',
            profileRevision: 'account-r1',
          },
          harness: 'codex',
          targetId: 'unavailable-selected-target',
          model: 'retained-model',
          reasoningEffort: 'high',
          mode: 'ask',
          authorityRefs: ['reference-only'],
        },
        workspace: { workspaceId: 'repo', sourceRefs: ['accepted-main'] },
        schedule: { cron: '0 9 * * *', timezone: 'Europe/Dublin', state: 'paused' },
        notificationPolicy: 'results',
        outputPolicy: 'session',
      },
    };
    const proposal = proposals.proposeTask('user', 'chat', 'call', input);
    const tasks = new AgentTaskStore(path);
    db.exec(
      "CREATE TRIGGER reject_task_receipt BEFORE UPDATE ON symposium_profile_proposals WHEN NEW.kind='task' BEGIN SELECT RAISE(ABORT,'simulated receipt failure'); END",
    );
    expect(() => proposals.saveTask('user', 'chat', proposal.proposalId, input)).toThrow(
      /simulated receipt failure/,
    );
    expect(tasks.get('user', 'atomic')).toBeNull();
    expect(db.prepare('SELECT * FROM agent_task_retries').all()).toEqual([]);
    db.exec('DROP TRIGGER reject_task_receipt');
    const saved = proposals.saveTask('user', 'chat', proposal.proposalId, input);
    expect(saved).toMatchObject({
      revision: 1,
      configuration: { state: 'blocked', reason: 'admission-unavailable' },
      definition: input.definition,
    });
    expect(saved.definition.execution).toEqual(input.definition.execution);
    tasks.close();
  } finally {
    proposals.close();
    db.close();
  }
});
