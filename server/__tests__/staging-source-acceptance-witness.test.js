import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, truncateSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProcessLocalSourceAcceptanceWitness,
  measureSourceHistoryScratch,
  SOURCE_HISTORY_SCRATCH_BYTES,
} from '../../scripts/lib/staging-source-acceptance-witness.mjs';
const target = 'a'.repeat(40),
  next = 'b'.repeat(40);
function fixture() {
  const receipt = {
    sourceCommit: target,
    sourceTree: 'c'.repeat(40),
    compiledArtifacts: { helper: 'd'.repeat(64) },
    dependencyFingerprint: 'e'.repeat(64),
  };
  let main = target,
    time = 0,
    snapshot = {
      receipt,
      receiptSha256: 'f'.repeat(64),
      sourceCommit: target,
      sourceTree: receipt.sourceTree,
      indexSha256: 'a'.repeat(64),
      helperSha256: 'd'.repeat(64),
      helperIdentity: { ino: 12 },
    };
  const e = {
    verifyFresh: vi.fn(async () => receipt),
    readPinned: vi.fn(async () => snapshot),
    readMain: vi.fn(async () => main),
    assertAcceptedAncestry: vi.fn(async () => {}),
    close: vi.fn(),
    now: () => time,
  };
  const owner = createProcessLocalSourceAcceptanceWitness(e);
  return {
    owner,
    e,
    receipt,
    setMain: (v) => {
      main = v;
    },
    setTime: (v) => {
      time = v;
    },
    drift: (field = 'indexSha256') => {
      snapshot = { ...snapshot, [field]: 'b'.repeat(64) };
    },
  };
}
it('admits exact fresh main, then permits a benign accepted advance while rechecking frozen bytes', async () => {
  const f = fixture(),
    token = await f.owner.admit(target);
  expect(JSON.parse(JSON.stringify(token))).toEqual({});
  f.setMain(next);
  expect(await f.owner.assertCurrent(token)).toEqual(f.receipt);
  expect(f.e.assertAcceptedAncestry).toHaveBeenCalledWith(target, next);
});
it('refuses stale admission, fabricated JSON witnesses and mutation of frozen source evidence', async () => {
  const stale = fixture();
  stale.setMain(next);
  await expect(stale.owner.admit(target)).rejects.toThrow();
  const f = fixture(),
    token = await f.owner.admit(target);
  await expect(f.owner.assertCurrent(JSON.parse(JSON.stringify(token)))).rejects.toThrow();
  f.drift();
  await expect(f.owner.assertCurrent(token)).rejects.toThrow();
});
it('refuses removed accepted ancestry and cannot replay a closed original witness', async () => {
  const f = fixture(),
    token = await f.owner.admit(target);
  f.setMain(next);
  f.e.assertAcceptedAncestry.mockRejectedValue(Error('revoked ancestry'));
  await expect(f.owner.assertCurrent(token)).rejects.toThrow();
  f.owner.close();
  await expect(f.owner.assertCurrent(token)).rejects.toThrow();
  await expect(f.owner.admit(target)).rejects.toThrow();
});
it('does not accept drift between source snapshots or a different receipt source at admission', async () => {
  const f = fixture();
  f.e.verifyFresh.mockResolvedValue({ ...f.receipt, sourceCommit: next });
  await expect(f.owner.admit(target)).rejects.toThrow();
});
it.each([
  'indexSha256',
  'helperSha256',
  'helperIdentity',
  'receiptSha256',
  'receipt',
  'sourceTree',
])('refuses pinned %s drift throughout the original operation', async (field) => {
  const f = fixture(),
    token = await f.owner.admit(target);
  f.drift(field);
  await expect(f.owner.assertCurrent(token)).rejects.toThrow();
});
it('refuses expired original-process acceptance even when all source bytes still match', async () => {
  const f = fixture(),
    token = await f.owner.admit(target);
  f.setTime(12 * 60 * 1000);
  await expect(f.owner.assertCurrent(token)).rejects.toThrow();
});
it('counts all own scratch bytes and rejects oversized stores and symbolic aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-witness-test-'));
  try {
    mkdirSync(join(root, 'objects'));
    writeFileSync(join(root, 'objects', 'alternates'), '/external/read-only/objects\n');
    expect(measureSourceHistoryScratch(root).files).toBe(1);
    const pack = join(root, 'objects', 'large.pack');
    writeFileSync(pack, '');
    truncateSync(pack, SOURCE_HISTORY_SCRATCH_BYTES + 1);
    expect(() => measureSourceHistoryScratch(root)).toThrow();
    rmSync(pack);
    symlinkSync('/external/read-only/objects', join(root, 'objects', 'alias'));
    expect(() => measureSourceHistoryScratch(root)).toThrow();
  } finally {
    rmSync(root, { recursive: true });
  }
});

it.each(['final-main', 'final-pinned', 'final-ancestry', 'close'])(
  'refuses %s crossing the original verification deadline',
  async (phase) => {
    const f = fixture();
    const token = await f.owner.admit(target);
    let reads = 0;
    f.e.readMain.mockImplementation(async () => {
      reads++;
      if (reads === 2 && phase === 'final-main') f.setTime(12 * 60 * 1000);
      return reads === 2 && phase === 'final-ancestry' ? next : target;
    });
    const originalPinned = f.e.readPinned.getMockImplementation();
    let pinnedReads = 0;
    f.e.readPinned.mockImplementation(async () => {
      if (++pinnedReads === 2) {
        if (phase === 'final-pinned') f.setTime(12 * 60 * 1000);
        if (phase === 'close') f.owner.close();
      }
      return originalPinned();
    });
    f.e.assertAcceptedAncestry.mockImplementation(async () => f.setTime(12 * 60 * 1000));
    await expect(f.owner.assertCurrent(token)).rejects.toThrow();
  },
);
