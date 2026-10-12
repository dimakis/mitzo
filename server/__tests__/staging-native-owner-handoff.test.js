import { expect, it, vi } from 'vitest';
import { createNativeOriginalOwnerHandoff } from '../../scripts/lib/staging-native-owner-handoff.mjs';
it('keeps original resource/check/drain fencing after consumed admission expires while refusing another start', () => {
  let initial = true,
    guard = true,
    native = true;
  const registered = vi.fn(() => true),
    auth = vi.fn(() => {
      if (!initial) throw Error('expired initial purpose auth');
    }),
    initialGuard = vi.fn(() => {
      if (!guard) throw Error('released deployment guard');
    });
  const owner = createNativeOriginalOwnerHandoff({
    assertRegisteredOriginal: registered,
    assertInitialGuard: initialGuard,
    assertInitialAuthentication: auth,
  });
  owner.assertFreshStartCurrent();
  owner.handoff(() => {
    if (!native) throw Error('original native owner lost');
  });
  initial = false;
  guard = false;
  expect(() => owner.assertCurrent()).not.toThrow();
  expect(() => owner.assertFreshStartCurrent()).toThrow();
  expect(() => owner.handoff(() => true)).toThrow();
  native = false;
  expect(() => owner.assertCurrent()).toThrow('owner lost');
});
it('never treats expired initial auth, asynchronous assertions or JSON as a native handoff', () => {
  const owner = createNativeOriginalOwnerHandoff({
    assertRegisteredOriginal: () => true,
    assertInitialGuard: () => true,
    assertInitialAuthentication: () => {
      throw Error('expired');
    },
  });
  expect(() => owner.handoff(() => true)).toThrow('expired');
  expect(() => owner.assertCurrent()).toThrow('expired');
  expect(() => createNativeOriginalOwnerHandoff(JSON.parse(JSON.stringify(owner)))).toThrow();
  const asyncOwner = createNativeOriginalOwnerHandoff({
    assertRegisteredOriginal: async () => true,
    assertInitialGuard: () => true,
    assertInitialAuthentication: () => true,
  });
  expect(() => asyncOwner.assertCurrent()).toThrow();
});
it('retains only the original post-host retirement lifetime after the app channel closes, with no replay', async () => {
  let app = true,
    retirement = true,
    registered = true;
  const owner = createNativeOriginalOwnerHandoff({
    assertRegisteredOriginal() {
      if (!registered) throw Error('original parent changed');
    },
    assertInitialGuard() {},
    assertInitialAuthentication() {},
  });
  owner.handoff(() => {
    if (!app) throw Error('app channel closed');
  });
  app = false;
  await owner.retire(
    () => {
      if (!retirement) throw Error('retirement lifetime expired');
    },
    async () => {
      owner.assertCurrent();
      expect(() => owner.assertFreshStartCurrent()).toThrow();
      expect(() => owner.handoff(() => {})).toThrow();
      retirement = false;
      expect(() => owner.assertCurrent()).toThrow('retirement lifetime expired');
      retirement = true;
      registered = false;
      expect(() => owner.assertCurrent()).toThrow('original parent changed');
      registered = true;
    },
  );
  expect(() => owner.assertCurrent()).toThrow();
  await expect(
    owner.retire(
      () => {},
      async () => {},
    ),
  ).rejects.toThrow();
});
it('refuses a retirement lifetime before a qualified original handoff and revokes it on failed cleanup', async () => {
  const owner = createNativeOriginalOwnerHandoff({
    assertRegisteredOriginal() {},
    assertInitialGuard() {},
    assertInitialAuthentication() {},
  });
  const cleanup = vi.fn();
  await expect(owner.retire(() => {}, cleanup)).rejects.toThrow();
  expect(cleanup).not.toHaveBeenCalled();
  owner.handoff(() => {});
  await expect(
    owner.retire(
      () => {},
      async () => {
        throw Error('uncertain stop');
      },
    ),
  ).rejects.toThrow('uncertain stop');
  expect(() => owner.assertCurrent()).toThrow();
});
