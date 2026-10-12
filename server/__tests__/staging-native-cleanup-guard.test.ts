import { describe, expect, it, vi } from 'vitest';
import { guardStagingNativeRuntimeEffects } from '../staging-native-runtime-effect.js';

describe('original native runtime effect queue fence', () => {
  it.each(['ensure', 'inspect', 'inspectReserved', 'stop', 'delete'] as const)(
    'rechecks the original queue immediately before and after awaited %s',
    async (method) => {
      const order: string[] = [];
      let current = true;
      const effect = vi.fn(async function (this: unknown) {
        expect(this).toBe(original);
        order.push('effect');
        current = false;
        return { sandboxName: 'name', sandboxId: 'id', workdir: '/fixture' };
      });
      const original = {
        ensure: effect,
        inspect: effect,
        inspectReserved: effect,
        stop: effect,
        delete: effect,
      };
      const fence = vi.fn(() => {
        order.push('queue');
        if (!current) throw Error('original queue quarantined');
      });
      const guarded = guardStagingNativeRuntimeEffects(original as never, fence);
      const invoke = guarded[method] as (...args: unknown[]) => Promise<unknown>;
      await expect(invoke('runtime', 'physical', new AbortController().signal)).rejects.toThrow(
        'queue quarantined',
      );
      expect(order).toEqual(['queue', 'effect', 'queue']);
      expect(effect).toHaveBeenCalledOnce();
      await expect(invoke('runtime', 'physical', new AbortController().signal)).rejects.toThrow(
        'queue quarantined',
      );
      expect(effect).toHaveBeenCalledOnce();
    },
  );
  it('keeps missing original lifecycle methods unavailable and returns only the original observed result', async () => {
    const observed = { sandboxName: 'actual-name', sandboxId: 'actual-id', workdir: '/fixture' };
    const original = { ensure: vi.fn().mockResolvedValue(observed) };
    const fence = vi.fn();
    const guarded = guardStagingNativeRuntimeEffects(original, fence);
    expect(guarded.stop).toBeUndefined();
    expect(guarded.delete).toBeUndefined();
    expect(await guarded.ensure('runtime', new AbortController().signal)).toBe(observed);
    expect(fence).toHaveBeenCalledTimes(2);
  });
});
