import { afterEach, expect, it, vi } from 'vitest';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import {
  retainTelosWorkRoleContext,
  resolveTelosWorkRoleContext,
} from '../telos-work-role-context.js';
import {
  retainTelosWorkRolePresentation,
  resolveTelosWorkRolePresentation,
} from '../telos-work-role-presentation.js';
import { resolveOrdinaryContributorGuidance } from '../ordinary-contributor-guidance.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
async function fixture() {
  const f = createTelosCanonicalData();
  cleanups.push(() => f.close());
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline fixture',
    provider: 'openai-codex' as const,
    profileRevision: 'r1',
    model: 'offline-fixture',
  };
  const workspaces = vi.fn(() => {
    throw Error('No allocation for retained projection');
  });
  const host = createTelosWorkRoleHost({
    dbPath: () => f.dbPath,
    events: f.events,
    ordinaryConversation: () => true,
    workspaces,
    authorizeSettings: async () => {
      throw Error('No settings admission for projection');
    },
    resolvePreparation: async () => {
      throw Error('No preparation for projection');
    },
  });
  const reviewed = await host.review({
    actor: f.actor,
    raw: {
      itemId: 'studio',
      role: 'lead',
      sourceSnapshotIds: [],
      artifactRefs: [
        { artifactId: f.material.id, revision: f.material.revision, sha256: f.material.sha256 },
      ],
    },
    signal: new AbortController().signal,
    assertAuthorized: () => {},
  });
  f.events.upsertSession({
    sessionId: 'lead',
    conversationSource: 'mitzo',
    accountBinding: binding,
  });
  retainTelosWorkRoleContext(f.events, 'lead', binding, reviewed.selection);
  return Object.assign(f, { binding, reviewed, workspaces });
}
it('CT05: presentation survives owner reopen and newer work/material without changing role events or guidance bytes', async () => {
  const f = await fixture();
  const original = f.events.getSessionEvents('lead');
  const guidance = resolveOrdinaryContributorGuidance(f.events, 'lead', f.binding);
  retainTelosWorkRolePresentation(f.events, 'lead', f.binding, f.reviewed);
  retainTelosWorkRolePresentation(f.events, 'lead', f.binding, f.reviewed);
  expect(
    f.events
      .getSessionEvents('lead')
      .filter((event) => event.type === 'telos_work_role_presentation'),
  ).toHaveLength(1);
  expect(
    f.events
      .getSessionEvents('lead')
      .filter((event) => event.type !== 'telos_work_role_presentation'),
  ).toEqual(original);
  f.db
    .prepare(
      "UPDATE items SET summary='Later studio title',intent='Later goal',updated_at='2026-10-18T11:00:00' WHERE id='studio'",
    )
    .run();
  f.artifacts.save({
    itemId: 'studio',
    filename: f.material.filename,
    title: 'A newer acoustic plan',
    bytes: Buffer.from('A newer plan.'),
    sessionId: 'planning',
  });
  f.restartOwners();
  expect(resolveTelosWorkRolePresentation(f.events, 'lead', f.binding)).toEqual({
    presentationRef: f.reviewed.presentationRef,
    presentation: f.reviewed.presentation,
  });
  expect(resolveTelosWorkRoleContext(f.events, 'lead', f.binding)).toEqual(f.reviewed.selection);
  expect(resolveOrdinaryContributorGuidance(f.events, 'lead', f.binding)).toBe(guidance);
  expect(f.workspaces).not.toHaveBeenCalled();
});
it('CT05: historical roles without display projection retain their original context and no invented labels', async () => {
  const f = await fixture();
  const previous = f.events.getSessionEvents('lead');
  expect(resolveTelosWorkRolePresentation(f.events, 'lead', f.binding)).toBeUndefined();
  expect(resolveTelosWorkRoleContext(f.events, 'lead', f.binding)).toEqual(f.reviewed.selection);
  expect(f.events.getSessionEvents('lead')).toEqual(previous);
});
it('CT05: a different account cannot retain or read the display projection', async () => {
  const f = await fixture();
  const changed = { ...f.binding, accountId: 'different-account' };
  expect(() => retainTelosWorkRolePresentation(f.events, 'lead', changed, f.reviewed)).toThrow();
  expect(
    f.events
      .getSessionEvents('lead')
      .filter((event) => event.type === 'telos_work_role_presentation'),
  ).toEqual([]);
  retainTelosWorkRolePresentation(f.events, 'lead', f.binding, f.reviewed);
  expect(() => resolveTelosWorkRolePresentation(f.events, 'lead', changed)).toThrow();
});
it.each(['conversation', 'goal', 'reference', 'duplicate'] as const)(
  'CT05: %s tampering cannot borrow the original full-context presentation',
  async (kind) => {
    const f = await fixture();
    retainTelosWorkRolePresentation(f.events, 'lead', f.binding, f.reviewed);
    const event = structuredClone(
      f.events
        .getSessionEvents('lead')
        .find((event) => event.type === 'telos_work_role_presentation')!,
    );
    const selection = structuredClone(f.reviewed.selection);
    if (kind === 'goal') selection.overallGoal.text = 'Different goal with the same brief hash';
    f.events.upsertSession({
      sessionId: 'other',
      conversationSource: 'mitzo',
      accountBinding: f.binding,
    });
    retainTelosWorkRoleContext(f.events, 'other', f.binding, selection);
    if (kind !== 'conversation') event.payload.sessionId = 'other';
    if (kind === 'reference')
      (event.payload.presentationRef as { sha256: string }).sha256 = 'f'.repeat(64);
    f.events.append('other', 'telos_work_role_presentation', event.payload);
    if (kind === 'duplicate') {
      const changed = structuredClone(event.payload);
      (changed.presentation as { item: { title: string } }).item.title =
        'A different retained label';
      f.events.append('other', 'telos_work_role_presentation', changed);
    }
    expect(() => resolveTelosWorkRolePresentation(f.events, 'other', f.binding)).toThrow();
    expect(resolveTelosWorkRolePresentation(f.events, 'lead', f.binding)).toEqual({
      presentationRef: f.reviewed.presentationRef,
      presentation: f.reviewed.presentation,
    });
  },
);
