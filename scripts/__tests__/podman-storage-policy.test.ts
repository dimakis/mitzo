import { describe, expect, it } from 'vitest';
import { planImages, applyImages } from '../lib/podman-storage-policy.mjs';

const id = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const now = Date.parse('2026-10-08T12:00:00Z');
function fixture() {
  const images = Array.from({ length: 8 }, (_, i) => ({
    id: id(i + 1),
    parent: '',
    layers: [`layer-${i + 1}`],
  }));
  return {
    collectedAt: now,
    complete: true,
    blockers: [],
    store: { connection: 'test', graphRoot: '/store', machineId: 'guest-1' },
    images,
    containers: [],
    telemetry: { guest: { status: 'available', freeBytes: 100, freeInodes: 10 } },
    enrollment: {
      version: 1,
      review: 'review-1',
      store: { connection: 'test', graphRoot: '/store', machineId: 'guest-1' },
      policy: { keepLatest: 2, graceDays: 7 },
      protections: Object.fromEntries(
        [
          'production',
          'staging',
          'provider',
          'supervisor',
          'candidate',
          'rollback',
          'checkpoint',
          'custodian',
        ].map((role) => [role, { complete: true, review: 'owner-review', images: [] }]),
      ),
      producers: [
        { owner: 'build-owner', family: 'runtime', coordinated: true, review: 'producer-review' },
      ],
      builds: images.map((image, i) => ({
        operation: `build-${i}`,
        owner: 'build-owner',
        family: 'runtime',
        state: 'succeeded',
        completedAt: now - (20 - i) * 86400000,
        reproducible: true,
        recipeDigest: 'sha256:recipe',
        images: [image.id],
      })),
    },
  };
}

describe('explicit image retention', () => {
  it('keeps latest two successful builds and seven-day grace', () => {
    const s = fixture();
    s.enrollment.builds[0].completedAt = now - 6 * 86400000;
    s.enrollment.builds[6].completedAt = now - 2 * 86400000;
    s.enrollment.builds[7].completedAt = now - 86400000;
    const p = planImages(s, now);
    expect(p.candidates.map((x) => x.id)).toEqual([id(2), id(3), id(4), id(5), id(6)]);
    expect(p.protected.find((x) => x.id === id(1))?.reasons).toContain('grace period');
    expect(p).not.toHaveProperty('promisedBytes');
  });
  it('protects stopped and created container images and ancestry', () => {
    const s = fixture();
    s.images[1].parent = id(1);
    s.containers = [
      { id: 'stopped', image: id(2) },
      { id: 'created', image: id(3) },
    ];
    expect(planImages(s, now).candidates.map((x) => x.id)).toEqual([id(4), id(5), id(6)]);
  });
  it('protects idle pinned supervisors, rollback and checkpoint images including layer ancestry', () => {
    const s = fixture();
    s.enrollment.protections.supervisor.images = [id(1)];
    s.enrollment.protections.rollback.images = [id(2)];
    s.enrollment.protections.checkpoint.images = [id(3)];
    s.images[2].layers = [...s.images[3].layers, 'checkpoint-layer'];
    expect(planImages(s, now).candidates.map((x) => x.id)).toEqual([id(5), id(6)]);
  });
  it('reports unowned/legacy data without adopting inherited labels', () => {
    const s = fixture();
    s.enrollment.builds = s.enrollment.builds.slice(1);
    s.images[0].labels = { 'mitzo.reproducible': 'true' };
    expect(planImages(s, now).candidates.map((x) => x.id)).not.toContain(id(1));
    expect(planImages(s, now).unclassified).toContain(id(1));
  });
  it.each([
    'partial',
    'store',
    'protection',
    'active',
    'uncertain',
    'uncoordinated',
    'ancestry',
    'ownership',
  ])('blocks unsafe %s evidence', (fault) => {
    const s = fixture();
    if (fault === 'partial') s.complete = false;
    if (fault === 'store') s.store.machineId = 'other-guest';
    if (fault === 'protection') delete s.enrollment.protections.custodian;
    if (fault === 'active' || fault === 'uncertain') s.enrollment.builds[0].state = fault;
    if (fault === 'uncoordinated') s.enrollment.producers[0].coordinated = false;
    if (fault === 'ancestry') s.images[0].parent = id(100);
    if (fault === 'ownership') s.enrollment.builds[0].recipeDigest = '';
    const p = planImages(s, now);
    expect(p.blockers.length).toBeGreaterThan(0);
    expect(p.candidates).toEqual([]);
  });
  it('orders eligible child before parent', () => {
    const s = fixture();
    s.images[1].parent = id(1);
    expect(
      planImages(s, now)
        .candidates.slice(0, 2)
        .map((x) => x.id),
    ).toEqual([id(2), id(1)]);
  });
});

describe('revalidated exact-ID application', () => {
  function adapter(s = fixture()) {
    const removed: string[] = [];
    return {
      s,
      removed,
      collect: async () => structuredClone(s),
      remove: async (image: string) => {
        removed.push(image);
        s.images = s.images.filter((x) => x.id !== image);
        return { code: 0 };
      },
      audit: async () => {},
    };
  }
  it('records removal only after exact absence and measures headroom', async () => {
    const a = adapter();
    const p = planImages(a.s, now);
    const result = await applyImages(p, a, { now: () => now });
    expect(a.removed).toEqual(p.candidates.map((x) => x.id));
    expect(result.status).toBe('complete');
    expect(result.outcomes.every((x) => x.status === 'removed')).toBe(true);
    expect(result.before.guest.freeBytes).toBe(100);
    expect(result.after.guest.freeInodes).toBe(10);
    expect(result).not.toHaveProperty('reclaimedBytes');
  });
  it.each(['expired', 'store', 'pin', 'reference', 'tampered'])(
    'refuses %s plans',
    async (fault) => {
      const a = adapter();
      const p = planImages(a.s, now);
      if (fault === 'store') a.s.store.machineId = 'other';
      if (fault === 'pin') a.s.enrollment.protections.supervisor.images = [id(1)];
      if (fault === 'reference') a.s.containers = [{ id: 'new', image: id(1) }];
      if (fault === 'tampered') p.candidates.push({ id: id(7), reasons: [] });
      const r = await applyImages(p, a, {
        now: () => (fault === 'expired' ? now + 16 * 60000 : now),
      });
      expect(r.status).toBe('blocked');
      expect(a.removed).toEqual([]);
    },
  );
  it('stops when a reference appears between deletions', async () => {
    const a = adapter();
    const remove = a.remove;
    a.remove = async (image) => {
      const r = await remove(image);
      a.s.containers = [{ id: 'concurrent', image: id(2) }];
      return r;
    };
    const r = await applyImages(planImages(a.s, now), a, { now: () => now });
    expect(a.removed).toEqual([id(1)]);
    expect(r.status).toBe('partial');
  });
  it('reports refusals and uncertain deletion without forcing or claiming success', async () => {
    const a = adapter();
    a.remove = async (image) => ({ code: image === id(1) ? 2 : 0 });
    const r = await applyImages(planImages(a.s, now), a, { now: () => now });
    expect(r.status).toBe('partial');
    expect(r.outcomes[0].status).toBe('skipped');
    expect(r.outcomes[1].status).toBe('failed');
  });
  it('cancels bounded work and refuses mutation when audit fails', async () => {
    const a = adapter();
    const signal = AbortSignal.abort();
    expect((await applyImages(planImages(a.s, now), a, { now: () => now, signal })).status).toBe(
      'blocked',
    );
    a.audit = async () => {
      throw Error('audit full');
    };
    await expect(applyImages(planImages(a.s, now), a, { now: () => now })).rejects.toThrow(
      'audit full',
    );
    expect(a.removed).toEqual([]);
  });
  it('reports final telemetry failure as partial even after every image was removed', async () => {
    const a = adapter();
    const collect = a.collect;
    a.collect = async () => {
      const s = await collect();
      if (s.images.length === 2) s.telemetry = { guest: { status: 'unavailable' } };
      return s;
    };
    const r = await applyImages(planImages(a.s, now), a, { now: () => now });
    expect(r.status).toBe('partial');
    expect(r.blockers).toContain('final guest measurement unavailable');
  });
  it('returns an audited partial result when collection fails between removals', async () => {
    const a = adapter();
    const collect = a.collect;
    let calls = 0;
    a.collect = async () => {
      if (++calls === 3) throw Error('read interrupted');
      return collect();
    };
    const r = await applyImages(planImages(a.s, now), a, { now: () => now });
    expect(r.status).toBe('partial');
    expect(a.removed).toEqual([id(1)]);
    expect(r.blockers).toContain('collection failed: read interrupted');
  });
});
