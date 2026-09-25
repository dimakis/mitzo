import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumProfileStore } from '../symposium-profiles.js';

const definition = {
  name: 'Independent reviewer',
  role: 'reviewer' as const,
  instructions: 'Review the pinned artifact. Report evidence and unresolved findings.',
  expectedOutput: 'Structured findings with evidence references',
  acceptanceCriteria: ['Each substantive finding identifies supporting evidence'],
  modelPolicyRole: 'reviewer',
};
let directory: string;
let profiles: SymposiumProfileStore;
const save = (extra = {}) =>
  profiles.save('owner', {
    profileId: 'reviewer',
    expectedRevision: 0,
    idempotencyKey: 'create-reviewer',
    definition,
    ...extra,
  });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-profiles-'));
  profiles = new SymposiumProfileStore(join(directory, 'events.db'));
});
afterEach(() => {
  profiles.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('portable Symposium profiles', () => {
  it('pins immutable content and uses CAS to preserve old versions', () => {
    const first = save();
    const second = save({
      expectedRevision: 1,
      idempotencyKey: 'revise',
      definition: {
        ...definition,
        instructions: 'Review changed lines against the pinned baseline.',
      },
    });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(first.contentHash).not.toBe(second.contentHash);
    expect(profiles.get('owner', 'reviewer', 1)).toEqual(first);
    expect(profiles.get('owner', 'reviewer')).toEqual(second);
    expect(() => save({ idempotencyKey: 'stale-create' })).toThrow(/revision/i);
  });
  it('reconciles exact retries after reopening and rejects conflicting retries', () => {
    const first = save();
    profiles.close();
    profiles = new SymposiumProfileStore(join(directory, 'events.db'));
    expect(save()).toEqual(first);
    expect(() => save({ definition: { ...definition, name: 'Different' } })).toThrow(
      /idempotency/i,
    );
  });
  it.each(['accountBinding', 'contextGrant', 'authorityGrant', 'credentials', 'apiKey'])(
    'refuses portable %s fields',
    (field) => {
      expect(() =>
        save({ definition: { ...definition, [field]: { secret: 'not-portable' } } }),
      ).toThrow();
    },
  );
  it('exports only a portable versioned definition and verifies imports against its content hash', () => {
    const first = save();
    const artifact = profiles.export('owner', 'reviewer', 1);
    expect(artifact).toEqual(first);
    expect(JSON.stringify(artifact)).not.toContain('owner');
    expect(profiles.import('another-owner', artifact, 'import-one')).toEqual(first);
    expect(profiles.get('another-owner', 'reviewer', 1)).toEqual(first);
    expect(() =>
      profiles.import(
        'third-owner',
        { ...artifact, definition: { ...definition, instructions: 'Tampered' } },
        'tamper',
      ),
    ).toThrow(/hash/i);
  });
  it('separates profile ownership and never treats a model policy role as an account grant', () => {
    save();
    expect(profiles.get('other', 'reviewer')).toBeNull();
    expect(profiles.list('other')).toEqual([]);
    expect(profiles.list('owner')[0].definition).toEqual(definition);
  });
  it('does not overwrite a locally divergent imported revision', () => {
    const first = save();
    profiles.save('other', {
      profileId: 'reviewer',
      expectedRevision: 0,
      idempotencyKey: 'local',
      definition: { ...definition, name: 'Local reviewer' },
    });
    expect(() => profiles.import('other', first, 'conflict')).toThrow(/revision|conflict/i);
  });
  it('imports a portable later revision without requiring the source owner history', () => {
    save();
    const later = save({
      expectedRevision: 1,
      idempotencyKey: 'revise',
      definition: { ...definition, instructions: 'Review the changed artifact.' },
    });
    expect(profiles.import('other', later, 'import-later')).toEqual(later);
    expect(profiles.get('other', 'reviewer', 1)).toBeNull();
    expect(profiles.get('other', 'reviewer', 2)).toEqual(later);
    expect(
      profiles.save('other', {
        profileId: 'reviewer',
        expectedRevision: 2,
        idempotencyKey: 'other-next',
        definition,
      }),
    ).toMatchObject({ revision: 3 });
  });
});
