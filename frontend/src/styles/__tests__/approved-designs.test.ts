import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const ledger = JSON.parse(readFileSync(resolve(root, 'docs/design/approved/ledger.json'), 'utf8'));

it('retains approved design references, human evidence and runnable regression contracts', () => {
  expect(ledger.version).toBe(1);
  expect(ledger.surfaces.length).toBeGreaterThan(0);
  const ids = ledger.surfaces.map((surface: { id: string }) => surface.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const surface of ledger.surfaces) {
    const active = surface.revisions.find(
      (revision: { id: string }) => revision.id === surface.activeRevision,
    );
    expect(active, `${surface.id}: missing active approval`).toBeDefined();
    for (const revision of surface.revisions) {
      expect(revision.approvedBy).toBeTruthy();
      expect(revision.approval.quote).toBeTruthy();
      expect(revision.approval.thread).toBeTruthy();
      expect(revision.invariants.length).toBeGreaterThan(0);
      expect(revision.references.length).toBeGreaterThan(0);
      for (const reference of revision.references) {
        expect(
          createHash('sha256')
            .update(readFileSync(resolve(root, reference.path)))
            .digest('hex'),
          `${surface.id}: approved reference changed; retain it and seek approval for a new revision`,
        ).toBe(reference.sha256);
      }
    }
    for (const path of [...active.sources, ...active.checks])
      expect(
        existsSync(resolve(root, path)),
        `${surface.id}: missing protected source/check ${path}`,
      ).toBe(true);
    expect(active.protectedChecks.length).toBeGreaterThan(0);
    for (const check of active.protectedChecks)
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(root, check.path)))
          .digest('hex'),
        `${surface.id}: approved design protection changed; retain the approval history and obtain approval for a new revision`,
      ).toBe(check.sha256);
  }
});

it.skipIf(!process.env.GITHUB_BASE_REF)(
  'keeps earlier approval revisions intact across the PR base',
  async () => {
    const { execFileSync } = await import('node:child_process');
    const ref = `origin/${process.env.GITHUB_BASE_REF}`;
    const file = 'docs/design/approved/ledger.json';
    // CI fetches full history. A missing base ref is a failure, not permission to
    // overwrite approval history. The initial ledger has no entry in the base.
    execFileSync('git', ['rev-parse', '--verify', ref], { cwd: root, stdio: 'pipe' });
    if (
      !execFileSync('git', ['ls-tree', '--name-only', ref, '--', file], {
        cwd: root,
        encoding: 'utf8',
      }).trim()
    )
      return;
    const previous = JSON.parse(
      execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' }),
    );
    for (const surface of previous.surfaces) {
      const retained = ledger.surfaces.find((entry: { id: string }) => entry.id === surface.id);
      expect(retained, `${surface.id}: cannot discard an approved surface`).toBeDefined();
      for (const revision of surface.revisions)
        expect(
          retained.revisions.find((entry: { id: string }) => entry.id === revision.id),
          `${surface.id}: append a new approval instead of rewriting history`,
        ).toEqual(revision);
    }
  },
);
