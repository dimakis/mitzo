import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TelosWorkItemSchema,
  TelosWorkSessionLinkSchema,
  TelosWorkAssignmentSchema,
  TelosWorkSourceSnapshotSchema,
  TelosWorkAttemptSchema,
  TelosWorkControlReceiptSchema,
} from '@mitzo/protocol';
import { createTelosWorkFixtures } from './fixtures/telos-work-fixtures.js';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

const root = resolve(import.meta.dirname, '../..');
const contractDirectory = resolve(root, 'docs/design/telos-workspaces');

describe('approved Telos work contract (S1; no runtime or UI qualification)', () => {
  it('pins the exported wire contract in the existing reviewed runtime manifest', () => {
    const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
    expect(artifacts['../../packages/protocol/src/telos-work.ts']).toBe(
      reviewedHandlerSourceFingerprint(
        readFileSync(resolve(root, 'packages/protocol/src/telos-work.ts'), 'utf8'),
      ),
    );
  });

  it('keeps origin-only Home studio and its unstarted slice unassigned', () => {
    const fixtures = createTelosWorkFixtures();
    const { items, links, assignments, attempts } = fixtures.homeStudio;
    expect(items.map((item) => TelosWorkItemSchema.parse(item).kind)).toEqual([
      'outcome',
      'work_item',
    ]);
    expect(items[1].parentId).toBe(items[0].itemId);
    expect(links.map((link) => TelosWorkSessionLinkSchema.parse(link).role)).toEqual([
      'origin',
      'origin',
    ]);
    expect(links[0].conversation).toEqual(links[1].conversation);
    expect(assignments).toEqual([]);
    expect(attempts).toEqual([]);
  });

  it('requires explicit kinds and rejects treating an external source as an ordinary lead', () => {
    const { homeStudio } = createTelosWorkFixtures();
    const missingKind = { ...homeStudio.items[0], kind: undefined };
    expect(TelosWorkItemSchema.safeParse(missingKind).success).toBe(false);
    const origin = homeStudio.links[0];
    expect(origin.conversation.namespace).toBe('external_codex');
    expect(TelosWorkSessionLinkSchema.safeParse({ ...origin, role: 'lead' }).success).toBe(false);
    expect(
      TelosWorkAssignmentSchema.safeParse({
        itemId: origin.itemId,
        role: 'lead',
        conversation: origin.conversation,
        revision: 1,
        assignedAt: null,
        assignedBy: null,
      }).success,
    ).toBe(false);
  });

  it('keeps a configured lead separate from its unstarted slice and source', () => {
    const { leadWithUnstartedSlice: fixture } = createTelosWorkFixtures();
    expect(fixture.assignments.map((a) => TelosWorkAssignmentSchema.parse(a).role)).toEqual([
      'lead',
    ]);
    const assignment = fixture.assignments[0];
    expect(assignment.itemId).toBe(fixture.items[0].itemId);
    expect(fixture.links.find((link) => link.role === 'origin')?.conversation).not.toEqual(
      assignment.conversation,
    );
    expect(fixture.links.filter((link) => link.role === 'worker')).toEqual([]);
    expect(fixture.attempts).toEqual([]);
    expect(fixture.conversations[0].binding.account.accountId).toBe('fixture-account-lead');
    expect(fixture.conversations[0].selection.model).toBe('fixture-luna');
  });

  it('retains several independent chats for one smallest item without changing assignment', () => {
    const { multipleChats: fixture } = createTelosWorkFixtures();
    expect(fixture.items).toHaveLength(1);
    const linked = fixture.links.map((link) => TelosWorkSessionLinkSchema.parse(link));
    expect(new Set(linked.map((link) => link.conversation.conversationId)).size).toBe(5);
    expect(linked.map((link) => link.role)).toEqual([
      'origin',
      'worker',
      'worker',
      'reviewer',
      'advisor',
    ]);
    expect(fixture.assignments).toHaveLength(1);
    expect(fixture.assignments[0].conversation).toEqual(linked[2].conversation);
    expect(fixture.initialChatSelection).toBeNull();
    expect(fixture.expectedUniqueChatCount).toBe(5);
    expect(new Set(fixture.conversations.map((c) => c.workspaceId)).size).toBe(4);
    expect(new Set(fixture.conversations.map((c) => c.draft)).size).toBe(4);
    expect(new Set(fixture.conversations.map((c) => c.binding.account.accountId)).size).toBe(4);
    expect(fixture.conversations.map((c) => c.historyMessageIds)).toEqual([
      ['fixture-message-previous'],
      ['fixture-message-current'],
      ['fixture-message-review'],
      ['fixture-message-advisor'],
    ]);
  });

  it('requires exact source selections, adopted brief and artifact revisions; keeps unknowns', () => {
    const snapshot = createTelosWorkFixtures().leadWithUnstartedSlice.snapshots[0];
    expect(TelosWorkSourceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.selection).toEqual({
      kind: 'selected',
      messageIds: ['fixture-source-message-12', 'fixture-source-message-18'],
      blockIds: ['fixture-source-block-18'],
      throughSequence: 18,
    });
    const artifact = snapshot.artifacts[0];
    for (const revision of [undefined, 0, 'latest']) {
      expect(
        TelosWorkSourceSnapshotSchema.safeParse({
          ...snapshot,
          artifacts: [{ ...artifact, revision }],
        }).success,
      ).toBe(false);
    }
    expect(
      TelosWorkSourceSnapshotSchema.safeParse({ ...snapshot, selection: undefined }).success,
    ).toBe(false);
    const unknown = createTelosWorkFixtures().legacyUnknown.snapshots[0];
    expect(TelosWorkSourceSnapshotSchema.parse(unknown).selection).toEqual({ kind: 'unknown' });
    expect(unknown.source).toBeNull();
    expect(unknown.author).toBeNull();
    expect(unknown.sourceCreatedAt).toBeNull();
    expect(unknown.adoptedAt).toBeNull();
  });

  it('preserves legacy language, long source snippets, dates, context and unmapped data', () => {
    const { legacyUnknown: fixture } = createTelosWorkFixtures();
    const item = TelosWorkItemSchema.parse(fixture.items[0]);
    expect(item).toEqual(fixture.items[0]);
    expect(item.itemId).toBe('fixture-legacy-item');
    expect(item.profile).toBe('centaur');
    expect(item.kind).toBeNull(); // Unknown legacy kind does not imply a coordinator.
    expect(item.intent).toBe('Keep the original outcome wording.');
    expect(item.rationale).toBe('Keep the original rationale.');
    expect(item.sources[0].rawSnippet.length).toBeGreaterThan(200);
    expect(item.sources[0].createdAt).toBeNull();
    expect(item.links[0].type).toBe('design');
    expect(item.createdAt).toBe('2026-09-08T10:00:00Z');
    expect(item.updatedAt).toBe('2026-09-09T11:00:00Z');
    expect(item.contextHints.sessionIds).toEqual(['fixture-legacy-session-hint']);
    expect(item.legacyFields).toEqual({ rankScore: 3.5, originalStatusLabel: 'manual import' });
    expect(fixture.assignments).toEqual([]);
  });

  it('represents six coordinated outcomes, unrelated Job work and explicit nesting', () => {
    const { coordinated: fixture } = createTelosWorkFixtures();
    const items = fixture.items.map((item) => TelosWorkItemSchema.parse(item));
    const rootCoordinator = items.find((item) => item.itemId === 'fixture-coordinator')!;
    expect(rootCoordinator.kind).toBe('coordinator');
    expect(items.filter((item) => item.parentId === rootCoordinator.itemId)).toHaveLength(6);
    expect(items.find((item) => item.itemId === 'fixture-job')?.parentId).toBeNull();
    const nested = createTelosWorkFixtures().nestedCoordinator.items;
    expect(nested.map((item) => item.kind)).toEqual(['coordinator', 'coordinator', 'outcome']);
    expect(nested[1].parentId).toBe(nested[0].itemId);
    expect(nested[2].parentId).toBe(nested[1].itemId);
    expect(fixture.controls.map((r) => TelosWorkControlReceiptSchema.parse(r).stage)).toEqual([
      'requested',
      'acknowledged',
      'applied',
      'released',
    ]);
    expect(fixture.controls.every((r) => r.targetOutcomeId !== 'fixture-job')).toBe(true);
    expect(fixture.controls[3].publicationRevalidation).toBe('required');
  });

  it('separates allocation uncertainty, chat readiness, execution and predecessor attempts', () => {
    const { attempts } = createTelosWorkFixtures().attemptRecovery;
    expect(attempts.map((attempt) => TelosWorkAttemptSchema.parse(attempt).state)).toEqual([
      'allocation_uncertain',
      'chat_ready',
    ]);
    expect(attempts[1].predecessorAttemptId).toBe(attempts[0].attemptId);
    expect(attempts[0].workerConversationId).toBeNull();
    expect(attempts[1].workerConversationId).not.toBeNull();
    expect(attempts[1].executionTaskId).toBeNull();
    expect(attempts[1].accountingGoalId).toBe('fixture-accounting-goal');
    expect(attempts[1].turnCommandId).toBeNull();
    expect(TelosWorkAttemptSchema.safeParse({ ...attempts[0], state: 'chat_ready' }).success).toBe(
      false,
    );
    expect(TelosWorkAttemptSchema.safeParse({ ...attempts[1], state: 'completed' }).success).toBe(
      false,
    );
  });

  it('returns fresh fixture state so one journey cannot mutate another', () => {
    const first = createTelosWorkFixtures();
    first.homeStudio.items[0].summary = 'Changed in this test';
    first.homeStudio.assignments.push(first.leadWithUnstartedSlice.assignments[0]);
    expect(createTelosWorkFixtures().homeStudio.items[0].summary).toBe('Home studio setup');
    expect(createTelosWorkFixtures().homeStudio.assignments).toEqual([]);
  });

  it('validates every scenario as contract data without allocating or running a session', () => {
    for (const fixture of Object.values(createTelosWorkFixtures())) {
      fixture.items.forEach((item) => TelosWorkItemSchema.parse(item));
      fixture.links.forEach((link) => TelosWorkSessionLinkSchema.parse(link));
      fixture.assignments.forEach((assignment) => TelosWorkAssignmentSchema.parse(assignment));
      fixture.snapshots.forEach((snapshot) => TelosWorkSourceSnapshotSchema.parse(snapshot));
      fixture.attempts.forEach((attempt) => TelosWorkAttemptSchema.parse(attempt));
      fixture.controls.forEach((receipt) => TelosWorkControlReceiptSchema.parse(receipt));
    }
  });

  it('maps UX01–UX24 exactly to downstream owners without claiming product acceptance', () => {
    const rows = JSON.parse(
      readFileSync(resolve(contractDirectory, 'acceptance-coverage.json'), 'utf8'),
    ) as Array<{
      id: string;
      slices: string[];
      owner: string;
      testFile: string;
      testCase: string;
      status: string;
      desktopEvidence: null;
      mobileEvidence: null;
      runtimeEvidence: null;
      reference: { id: string; revision: number; sha256: string };
    }>;
    expect(rows.map((row) => row.id)).toEqual(
      Array.from({ length: 24 }, (_, index) => `UX${String(index + 1).padStart(2, '0')}`),
    );
    for (const row of rows) {
      expect(row.slices.length).toBeGreaterThan(0);
      expect(row.owner.length).toBeGreaterThan(0);
      expect(row.testFile).toMatch(/\.(test|spec)\.(ts|tsx)$/);
      expect(row.testCase.length).toBeGreaterThan(0);
      expect(row.status).toBe('planned');
      expect(row.desktopEvidence).toBeNull();
      expect(row.mobileEvidence).toBeNull();
      expect(row.runtimeEvidence).toBeNull();
      expect(row.reference).toEqual({
        id: '9d0559132154b92d0bbb427a982a0002',
        revision: 1,
        sha256: '97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab',
      });
    }
  });

  it('resolves each Mitzo source owner against accepted source and marks new modules proposed', () => {
    const owners = JSON.parse(
      readFileSync(resolve(contractDirectory, 'source-owners.json'), 'utf8'),
    ) as Array<{
      ownerId: string;
      boundary: string;
      repository: string;
      existingPaths: string[];
      proposedPaths: string[];
      integrationGap: string;
    }>;
    expect(owners.length).toBeGreaterThanOrEqual(11);
    for (const owner of owners) {
      expect(owner.ownerId).toMatch(/^[a-f0-9]{16}$/);
      expect(owner.integrationGap.length).toBeGreaterThan(0);
      expect(owner.existingPaths.length).toBeGreaterThan(0);
      if (owner.repository === 'mitzo') {
        for (const path of owner.existingPaths)
          expect(existsSync(resolve(root, path)), path).toBe(true);
      }
    }
  });
});
