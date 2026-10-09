import { expect, it, vi } from 'vitest';
import { requalifyStage } from '../../scripts/lib/staging-requalification.mjs';

function effects(overrides = {}) {
  const trace = [];
  const effect = (name) => vi.fn(async () => trace.push(name));
  return {
    trace,
    lock: effect('lock'),
    verify: effect('verify'),
    preserve: effect('preserve'),
    migrate: effect('migrate'),
    check: effect('check'),
    audit: effect('audit'),
    unlock: effect('unlock'),
    ...overrides,
  };
}
it('archives original evidence before metadata migration and verifies before releasing the fence', async () => {
  const e = effects();
  await requalifyStage(e);
  expect(e.trace).toEqual(['lock', 'verify', 'preserve', 'migrate', 'check', 'audit', 'unlock']);
});
it('releases a refused pre-mutation operation without migrating or controlling a service', async () => {
  const e = effects({
    verify: vi.fn(async () => {
      throw Error('changed original');
    }),
  });
  await expect(requalifyStage(e)).rejects.toThrow('changed original');
  expect(e.preserve).not.toHaveBeenCalled();
  expect(e.migrate).not.toHaveBeenCalled();
  expect(e.unlock).toHaveBeenCalledOnce();
});
it('retains the lock on an uncertain metadata migration, without automatic rollback or restart', async () => {
  const e = effects({
    migrate: vi.fn(async () => {
      throw Error('partial write');
    }),
  });
  await expect(requalifyStage(e)).rejects.toThrow('partial write');
  expect(e.unlock).not.toHaveBeenCalled();
  expect(e.check).not.toHaveBeenCalled();
  expect(e.audit).toHaveBeenCalledWith('uncertain');
});
it('retains the uncertainty fence when archiving fails after creating partial evidence', async () => {
  const e = effects({
    preserve: vi.fn(async () => {
      throw Error('partial archive');
    }),
  });
  await expect(requalifyStage(e)).rejects.toThrow('partial archive');
  expect(e.migrate).not.toHaveBeenCalled();
  expect(e.unlock).not.toHaveBeenCalled();
  expect(e.audit).toHaveBeenCalledWith('uncertain');
});
