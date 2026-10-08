import { createHash } from 'node:crypto';

export const protectionRoles = [
  'production',
  'staging',
  'provider',
  'supervisor',
  'candidate',
  'rollback',
  'checkpoint',
  'custodian',
];
export const imageId = /^sha256:[a-f0-9]{64}$/;
const day = 86400000;
// Stable object ordering makes file formatting irrelevant to revalidation.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const inventoryGuard = (s) =>
  digest({
    store: s.store,
    enrollment: s.enrollment,
    images: [...s.images].sort((a, b) => a.id.localeCompare(b.id)),
    containers: [...s.containers].sort((a, b) => a.id.localeCompare(b.id)),
  });

/** Only explicit host enrollment proves disposal authority. Labels and image age do not. */
export function planImages(s, now = Date.now()) {
  const blockers = [...(s.blockers ?? [])];
  const e = s.enrollment;
  const images = new Map((s.images ?? []).map((i) => [i.id, i]));
  const reasons = new Map();
  const unclassified = [];
  const protect = (id, reason) => {
    if (!images.has(id)) {
      blockers.push(`missing protected image: ${id}`);
      return;
    }
    if (!reasons.has(id)) reasons.set(id, new Set());
    reasons.get(id).add(reason);
  };
  if (!s.complete) blockers.push('partial inventory');
  if (!e || e.version !== 1 || !e.review || digest(e.store) !== digest(s.store))
    blockers.push('store enrollment missing or changed');
  const keep = e?.policy?.keepLatest;
  const grace = e?.policy?.graceDays;
  if (!Number.isInteger(keep) || keep < 2 || !Number.isFinite(grace) || grace < 7)
    blockers.push('invalid retention policy');
  if (images.size !== s.images?.length) blockers.push('duplicate image identity');
  for (const i of images.values()) {
    if (
      !imageId.test(i.id) ||
      typeof i.parent !== 'string' ||
      !Array.isArray(i.layers) ||
      !i.layers.length ||
      i.layers.some((l) => typeof l !== 'string' || !l)
    )
      blockers.push(`incomplete image ancestry: ${i.id}`);
    if (i.parent && !images.has(i.parent)) blockers.push(`missing ancestor: ${i.parent}`);
  }
  for (const c of s.containers ?? []) protect(c.image, `container: ${c.id}`);
  for (const role of protectionRoles) {
    const source = e?.protections?.[role];
    if (!source?.complete || !source.review || !Array.isArray(source.images))
      blockers.push(`missing protection evidence: ${role}`);
    else for (const ref of source.images) protect(ref, `pin: ${role}`);
  }
  const owned = new Map();
  const builds = e?.builds;
  const producers = e?.producers;
  if (!Array.isArray(builds) || !Array.isArray(producers))
    blockers.push('missing producer evidence');
  for (const p of producers ?? [])
    if (!p.owner || !p.family || !p.coordinated || !p.review)
      blockers.push(`uncoordinated producer: ${p.owner}`);
  for (const b of builds ?? []) {
    if (b.state !== 'succeeded') {
      blockers.push(`unresolved build: ${b.operation}`);
      continue;
    }
    if (
      !b.operation ||
      !b.reproducible ||
      !b.recipeDigest ||
      !Number.isFinite(b.completedAt) ||
      b.completedAt > now ||
      !Array.isArray(b.images) ||
      !b.images.length ||
      !(producers ?? []).some(
        (p) => p.owner === b.owner && p.family === b.family && p.coordinated && p.review,
      )
    ) {
      blockers.push(`missing build ownership: ${b.operation}`);
      continue;
    }
    for (const id of b.images) {
      if (!imageId.test(id)) blockers.push(`non-immutable build image: ${id}`);
      if (!owned.has(id)) owned.set(id, []);
      owned.get(id).push(b);
    }
  }
  for (const p of producers ?? []) {
    const recent = (builds ?? [])
      .filter((b) => b.owner === p.owner && b.family === p.family && b.state === 'succeeded')
      .sort((a, b) => b.completedAt - a.completedAt || a.operation.localeCompare(b.operation));
    for (const b of recent.slice(0, keep))
      for (const id of b.images ?? []) if (images.has(id)) protect(id, 'latest successful builds');
  }
  for (const i of images.values()) {
    const records = owned.get(i.id);
    if (!records) {
      unclassified.push(i.id);
      protect(i.id, 'unclassified');
    } else if (records.some((b) => now - b.completedAt < grace * day))
      protect(i.id, 'grace period');
  }
  // Parent metadata and layer-prefix ancestry both protect intermediate images.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...reasons.keys()]) {
      const i = images.get(id);
      const ancestors = [...images.values()].filter(
        (a) =>
          a.id !== id &&
          (a.id === i.parent ||
            (a.layers?.length < i.layers?.length &&
              a.layers?.every((layer, n) => layer === i.layers[n]))),
      );
      for (const a of ancestors)
        if (!reasons.has(a.id)) {
          protect(a.id, `ancestor of: ${id}`);
          changed = true;
        }
    }
  }
  // Reject cycles rather than trying to rank an ambiguous parent graph.
  const depth = (id, seen = new Set()) => {
    if (seen.has(id)) {
      blockers.push(`ancestry cycle: ${id}`);
      return 0;
    }
    seen.add(id);
    const parent = images.get(id)?.parent;
    return parent && images.has(parent) ? 1 + depth(parent, seen) : 0;
  };
  const depths = new Map([...images.keys()].map((id) => [id, depth(id)]));
  const candidates = [...images.values()]
    .filter((i) => !reasons.has(i.id))
    .sort(
      (a, b) =>
        depths.get(b.id) - depths.get(a.id) ||
        b.layers.length - a.layers.length ||
        a.id.localeCompare(b.id),
    )
    .map((i) => ({
      id: i.id,
      reasons: [
        'owned reproducible completed build',
        'outside latest-build retention and grace',
        'no protected reference or ancestry',
      ],
    }));
  const plan = {
    version: 1,
    createdAt: now,
    expiresAt: now + 15 * 60000,
    store: s.store,
    guard: inventoryGuard(s),
    snapshot: { store: s.store, enrollment: e, images: s.images, containers: s.containers },
    candidates: blockers.length ? [] : candidates,
    protected: [...reasons].map(([id, r]) => ({ id, reasons: [...r] })),
    unclassified,
    blockers: [...new Set(blockers)],
    telemetry: s.telemetry,
  };
  return { ...plan, seal: digest(plan) };
}

/** Caller holds the store's host maintenance lock for the entire operation. */
export async function applyImages(plan, adapter, { now = Date.now, signal } = {}) {
  const result = {
    status: 'blocked',
    outcomes: [],
    blockers: [],
    before: null,
    after: null,
    startedAt: now(),
  };
  const finish = async () => {
    try {
      result.after = (await adapter.collect()).telemetry;
    } catch {
      result.blockers.push('final measurement unavailable');
    }
    if (result.after?.guest?.status !== 'available')
      result.blockers.push('final guest measurement unavailable');
    if (result.blockers.length && result.status === 'complete')
      result.status = result.outcomes.length ? 'partial' : 'blocked';
    result.finishedAt = now();
    await adapter.audit({ event: 'finished', ...result });
    return result;
  };
  const { seal, ...content } = plan;
  if (
    seal !== digest(content) ||
    plan.version !== 1 ||
    !Number.isFinite(plan.createdAt) ||
    now() < plan.createdAt ||
    now() > plan.expiresAt ||
    plan.expiresAt - plan.createdAt > 15 * 60000 ||
    signal?.aborted
  ) {
    result.blockers.push('invalid, expired or cancelled plan');
    return finish();
  }
  await adapter.audit({
    event: 'started',
    planSeal: seal,
    store: plan.store,
    candidates: plan.candidates,
  });
  const expected = structuredClone(plan.snapshot);
  for (const candidate of plan.candidates) {
    if (signal?.aborted) {
      result.blockers.push('cancelled');
      break;
    }
    let s;
    try {
      s = await adapter.collect();
    } catch (error) {
      result.blockers.push(
        `collection failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      break;
    }
    result.before ??= s.telemetry;
    const fresh = planImages(s, now());
    if (
      fresh.blockers.length ||
      inventoryGuard(s) !== inventoryGuard(expected) ||
      !fresh.candidates.some((c) => c.id === candidate.id)
    ) {
      result.blockers.push(...fresh.blockers, 'plan evidence changed; replan required');
      break;
    }
    await adapter.audit({ event: 'removing', id: candidate.id });
    let outcome;
    try {
      const removal = await adapter.remove(candidate.id, signal);
      const observed = await adapter.collect();
      const absent = observed.complete && !observed.images.some((i) => i.id === candidate.id);
      outcome = {
        id: candidate.id,
        status:
          removal.code === 0 && absent ? 'removed' : removal.code === 2 ? 'skipped' : 'failed',
        code: removal.code,
        detail: removal.detail,
      };
      if (absent) expected.images = expected.images.filter((i) => i.id !== candidate.id);
    } catch (error) {
      outcome = {
        id: candidate.id,
        status: 'failed',
        detail: error instanceof Error ? error.message : 'unknown deletion outcome',
      };
    }
    result.outcomes.push(outcome);
    await adapter.audit({ event: 'outcome', ...outcome });
  }
  if (!plan.candidates.length) {
    const s = await adapter.collect();
    result.before = s.telemetry;
    result.blockers.push(...planImages(s, now()).blockers, ...plan.blockers);
  }
  result.status =
    result.blockers.length || result.outcomes.some((o) => o.status !== 'removed')
      ? result.outcomes.length
        ? 'partial'
        : 'blocked'
      : 'complete';
  return finish();
}
