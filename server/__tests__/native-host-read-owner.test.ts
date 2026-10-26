import { expect, it, vi } from 'vitest';
import {
  captureNativeHostReadOwner,
  assertNativeHostReadCurrentSync,
  type NativeHostToolContext,
} from '../native-host-tool-context.js';

// Malformed-facet validation only. These structural fixtures confer no native
// authority; the signed fixture covers the actual producer and its live owner.
function fixture(kind: string, result?: () => unknown) {
  const getter = vi.fn(() => {
    throw Error('Getter must not run');
  });
  const scope = Object.freeze({});
  const signal = new AbortController().signal;
  const context = { nativeBaseReadScope: scope, signal };
  const capture = Object.freeze(function () {
    if (kind === 'false') return false;
    if (kind === 'promise') return Promise.resolve(null);
    const fields: Record<string, unknown> = {
      context: kind === 'wrong-context' ? Object.freeze({}) : context,
      scope: kind === 'wrong-scope' ? Object.freeze({}) : scope,
      signal,
      assertCurrentSync: Object.freeze(kind === 'sync-result' ? result! : () => {}),
      assertCurrent: Object.freeze(kind === 'async-result' ? result! : async () => {}),
    };
    if (kind === 'enumerable') return Object.freeze(fields);
    const descriptors: PropertyDescriptorMap = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, { value }]),
    );
    if (kind === 'field-getter') descriptors.context = { get: getter };
    return Object.freeze(Object.defineProperties({}, descriptors));
  });
  if (kind === 'inherited') Object.setPrototypeOf(context, { captureNativeReadOwner: capture });
  else if (kind === 'accessor')
    Object.defineProperty(context, 'captureNativeReadOwner', { get: getter });
  else Object.defineProperty(context, 'captureNativeReadOwner', { value: capture });
  return { context: Object.freeze(context) as unknown as NativeHostToolContext, getter };
}

it.each([
  'accessor',
  'inherited',
  'false',
  'promise',
  'wrong-context',
  'wrong-scope',
  'enumerable',
  'field-getter',
])('refuses present malformed %s capture instead of falling back or executing getters', (kind) => {
  const f = fixture(kind);
  expect(() => captureNativeHostReadOwner(f.context)).toThrow();
  expect(f.getter).not.toHaveBeenCalled();
});
it.each([false, Promise.resolve(undefined)])('refuses non-void sync owner result %s', (result) => {
  const f = fixture('sync-result', () => result);
  expect(() => captureNativeHostReadOwner(f.context)!.assertCurrentSync()).toThrow();
});
it.each([false, Promise.resolve(false)])(
  'refuses a non-Promise or non-void async owner result %s',
  async (result) => {
    const f = fixture('async-result', () => result);
    await expect(captureNativeHostReadOwner(f.context)!.assertCurrent()).rejects.toThrow();
  },
);
it('retains both generic assertions and their receivers even for an identical function', () => {
  const receivers: unknown[] = [];
  const same = Object.freeze(function (this: unknown) {
    receivers.push(this);
  });
  const scope = { assertCurrentSync: same };
  const context = { assertCurrentSync: same } as unknown as NativeHostToolContext;
  expect(captureNativeHostReadOwner(context)).toBeUndefined();
  assertNativeHostReadCurrentSync(
    context,
    scope as NonNullable<NativeHostToolContext['nativeBaseReadScope']>,
  );
  expect(receivers).toEqual([context, scope]);
});
it.each([false, Promise.resolve(undefined)])('refuses non-void generic assertions %s', (value) => {
  const context = { assertCurrentSync: () => value } as unknown as NativeHostToolContext;
  const next = vi.fn();
  expect(() =>
    assertNativeHostReadCurrentSync(context, { assertCurrentSync: next } as unknown as NonNullable<
      NativeHostToolContext['nativeBaseReadScope']
    >),
  ).toThrow();
  expect(next).not.toHaveBeenCalled();
});
