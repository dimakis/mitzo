import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLibraryStore } from '../agent-library-store.js';
import { SymposiumProfileStore } from '../symposium-profiles.js';

const definition = {
  name: 'Bob',
  descriptor: 'The architect',
  description: 'Challenge architecture proposals.',
  role: 'reviewer',
  instructions: 'Challenge assumptions and compare viable options.',
  expectedOutput: 'A decision brief with risks and open questions',
  acceptanceCriteria: ['Support each finding with evidence'],
  modelPolicyRole: 'reviewer',
};
let directory: string;
let library: AgentLibraryStore;
const draft = (extra = {}) =>
  library.saveDraft('user', {
    profileId: 'bob',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'create-bob',
    definition,
    ...extra,
  });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-agent-library-'));
  library = new AgentLibraryStore(join(directory, 'events.db'));
});
afterEach(() => {
  library.close();
  rmSync(directory, { recursive: true, force: true });
});

it('keeps drafts out of the published catalog and retains them across restart', () => {
  const saved = draft();
  expect(library.list('user')).toEqual({ drafts: [saved], versions: [] });
  expect(library.list('another-owner')).toEqual({ drafts: [], versions: [] });
  library.close();
  library = new AgentLibraryStore(join(directory, 'events.db'));
  expect(library.getDraft('user', 'bob')).toEqual(saved);
  expect(draft()).toEqual(saved);
});
it('publishes into the existing Symposium catalog and retains immutable names and guidance', () => {
  draft();
  const first = library.publish('user', {
    profileId: 'bob',
    expectedVersion: 1,
    idempotencyKey: 'publish-bob',
  });
  expect(first.definition).toEqual(definition);
  expect(library.getDraft('user', 'bob')).toBeNull();
  const symposium = new SymposiumProfileStore(join(directory, 'events.db'));
  expect(symposium.get('user', 'bob', 1)).toEqual(first);
  symposium.close();
  const next = draft({
    expectedRevision: 1,
    idempotencyKey: 'edit-bob',
    definition: { ...definition, name: 'Robert' },
  });
  expect(next.version).toBeGreaterThan(1);
  expect(() =>
    library.publish('user', {
      profileId: 'bob',
      expectedVersion: 1,
      idempotencyKey: 'outdated-draft',
    }),
  ).toThrow(/conflict/i);
  const second = library.publish('user', {
    profileId: 'bob',
    expectedVersion: next.version,
    idempotencyKey: 'publish-robert',
  });
  expect(second.revision).toBe(2);
  expect(library.version('user', 'bob', 1)).toEqual(first);
  expect(library.version('user', 'bob', 2)?.definition.name).toBe('Robert');
  expect(
    library.publish('user', {
      profileId: 'bob',
      expectedVersion: 1,
      idempotencyKey: 'publish-bob',
    }),
  ).toEqual(first);
});
it('rejects stale concurrent edits, publication, and conflicting retries', () => {
  draft();
  expect(() => draft({ idempotencyKey: 'stale' })).toThrow(/conflict/i);
  expect(() => draft({ definition: { ...definition, name: 'Ada' } })).toThrow(/idempotency/i);
  draft({
    expectedVersion: 1,
    idempotencyKey: 'edit',
    definition: { ...definition, descriptor: 'Systems architect' },
  });
  expect(() =>
    library.publish('user', {
      profileId: 'bob',
      expectedVersion: 1,
      idempotencyKey: 'stale-publish',
    }),
  ).toThrow(/conflict/i);
  expect(library.list('user').versions).toHaveLength(0);
});
it('refuses to publish over a revision saved by another profile consumer', () => {
  draft();
  const symposium = new SymposiumProfileStore(join(directory, 'events.db'));
  symposium.save('user', {
    profileId: 'bob',
    expectedRevision: 0,
    idempotencyKey: 'other-edit',
    definition,
  });
  symposium.close();
  expect(() =>
    library.publish('user', { profileId: 'bob', expectedVersion: 1, idempotencyKey: 'publish' }),
  ).toThrow(/revision conflict/i);
  expect(library.getDraft('user', 'bob')).not.toBeNull();
});
it('imports a verified portable version as a new draft without overwriting existing identities', () => {
  draft();
  const original = library.publish('user', {
    profileId: 'bob',
    expectedVersion: 1,
    idempotencyKey: 'publish',
  });
  const imported = library.importDraft('user', {
    profileId: 'bob-copy',
    artifact: original,
    idempotencyKey: 'import',
  });
  expect(imported.definition.descriptor).toBe('The architect');
  expect(library.list('user').versions).toHaveLength(1);
  expect(
    library.importDraft('user', {
      profileId: 'bob-copy',
      artifact: original,
      idempotencyKey: 'import',
    }),
  ).toEqual(imported);
  expect(() =>
    library.importDraft('user', {
      profileId: 'tampered',
      artifact: { ...original, definition: { ...definition, name: 'Changed' } },
      idempotencyKey: 'tampered',
    }),
  ).toThrow(/hash/i);
});
it.each(['descriptor', 'description'])(
  'validates private material in the %s identity field',
  (field) => {
    expect(() => draft({ definition: { ...definition, [field]: 'password=secret' } })).toThrow(
      /portable/i,
    );
  },
);
it('retains legacy identity and hashes when descriptor fields are absent', () => {
  const { descriptor: _descriptor, description: _description, ...legacy } = definition;
  const saved = draft({ definition: legacy });
  expect(saved.definition).toEqual(legacy);
  expect(
    library.publish('user', { profileId: 'bob', expectedVersion: 1, idempotencyKey: 'legacy' })
      .definition,
  ).toEqual(legacy);
});
it('rejects authority-bearing fields and oversized identity values', () => {
  expect(() =>
    draft({ definition: { ...definition, accountBinding: { accountId: 'work' } } }),
  ).toThrow();
  expect(() => draft({ definition: { ...definition, descriptor: 'x'.repeat(81) } })).toThrow();
  expect(() => draft({ definition: { ...definition, description: 'x'.repeat(501) } })).toThrow();
});
