import { expect, it, vi } from 'vitest';
import { createOriginalCustodianLifetime } from '../symposium-original-custodian-lifetime.js';
it('retains the actual host lifetime through app-channel quiescence and closes permanently for native retirement', () => {
  let host = true;
  const custody = vi.fn(() => {
    if (!host) throw Error('actual host lost');
  });
  const lifetime = createOriginalCustodianLifetime({
    instanceId: 'original',
    assertHostCurrent: custody,
  });
  expect(lifetime.identity).toEqual({ instanceId: 'original', custodianPid: process.pid });
  lifetime.assertCurrent();
  // No app epoch/admission expiry enters this retained original-host proof.
  lifetime.assertCurrent();
  host = false;
  expect(() => lifetime.assertCurrent()).toThrow('actual host lost');
  host = true;
  expect(() => lifetime.assertCurrent()).toThrow('lifetime unavailable');
  lifetime.close();
  expect(() => lifetime.assertCurrent()).toThrow('lifetime unavailable');
  expect(() => lifetime.assertCurrent()).toThrow('lifetime unavailable');
});
it('refuses asynchronous/false custody and serialized lifetimes', () => {
  expect(() =>
    createOriginalCustodianLifetime({ instanceId: 'original', assertHostCurrent: () => false }),
  ).toThrow();
  expect(() =>
    createOriginalCustodianLifetime({
      instanceId: 'original',
      assertHostCurrent: async () => {
        throw Error('not custody');
      },
    }),
  ).toThrow('synchronous');
  const lifetime = createOriginalCustodianLifetime({
    instanceId: 'original',
    assertHostCurrent() {},
  });
  expect(() => createOriginalCustodianLifetime(JSON.parse(JSON.stringify(lifetime)))).toThrow();
});
