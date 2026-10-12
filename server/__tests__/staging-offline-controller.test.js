import { it, expect, vi } from 'vitest';
import { recoveryProposal } from './fixtures/staging-offline-plans.js';
import { applyOfflineRecoveryProposal } from '../../scripts/lib/staging-offline-controller.mjs';
import { createProcessLocalSourceAcceptanceWitness } from '../../scripts/lib/staging-source-acceptance-witness.mjs';
function fixture() {
  const proposal = recoveryProposal();
  const order = [];
  const token = {};
  const base = { assertCurrent: vi.fn(() => true), close: vi.fn() };
  const closeAuthorizer = vi.fn();
  const receiptSha256 = 'e'.repeat(64);
  const deps = {
    createSourceWitness: ({ verifyFresh }) => {
      const original = createProcessLocalSourceAcceptanceWitness({
        verifyFresh,
        readPinned: async () => ({
          receipt: await verifyFresh(),
          sourceCommit: proposal.ordinaryPlan.facts.source.sourceCommit,
        }),
        readMain: async () => proposal.ordinaryPlan.facts.source.sourceCommit,
        assertAcceptedAncestry: async () => {
          throw Error('Unexpected synthetic ancestry change');
        },
        close: vi.fn(),
      });
      return {
        ...original,
        async admit(target) {
          order.push('admit source');
          return original.admit(target);
        },
      };
    },
    enroll: async (_source, verify) => {
      await verify();
      order.push('enroll');
      return { helperPath: '/compiled/helper', expectedSha256: 'a'.repeat(64) };
    },
    createAuthorizer: () => ({
      close: closeAuthorizer,
      authenticate: async () => {
        order.push('authenticate');
        return token;
      },
      consume: (authority, sha) => {
        expect(authority).toBe(token);
        expect(sha).toBe(proposal.sha256);
        return base;
      },
    }),
    createInspectionOwner: ({ verifyExecutingSource }) => ({
      assertBeforeMove: async () => {
        await verifyExecutingSource();
      },
      assertContained: async () => {
        await verifyExecutingSource();
        order.push('physical contained');
      },
    }),
    createNativeEffects: async (args) => ({
      ...args.inspectionOwner,
      assertGuardContinuation: args.assertGuardContinuation,
    }),
    createTransaction: (args) => ({
      apply: async (authority) => {
        const lease = args.consumeAuthority(authority, args.plan.sha256);
        lease.assertCurrent(args.plan.sha256);
        order.push('preserve native');
        await args.continueGuard({ assertOwnedGuard: () => receiptSha256 }, { receiptSha256 });
        lease.close();
        return { nativeCleanupConfirmed: false };
      },
    }),
    createOrdinaryEffects: () => ({
      getReplacementProof: () => undefined,
      assertGuardContinuation: () => true,
    }),
    createRestoration: (args) => ({
      apply: async (authority) => {
        const lease = await args.consumeAuthority(authority, args.plan.sha256);
        order.push('restore ordinary');
        lease.assertCurrent(args.plan.sha256);
        lease.close();
        return { mode: 'ordinary' };
      },
    }),
  };
  const verifySource = vi.fn(async () => ({
    sourceCommit: proposal.ordinaryPlan.facts.source.sourceCommit,
  }));
  return {
    proposal,
    sourceRoot: '/qualified/release',
    verifySource,
    deps,
    order,
    base,
    closeAuthorizer,
  };
}
it('wires a single qualified helper and original containment capsule into ordinary restoration', async () => {
  const f = fixture();
  const result = await applyOfflineRecoveryProposal(f, f.deps);
  expect(f.order).toEqual([
    'enroll',
    'admit source',
    'authenticate',
    'preserve native',
    'physical contained',
    'restore ordinary',
  ]);
  expect(f.base.close).toHaveBeenCalledTimes(1);
  expect(f.closeAuthorizer).toHaveBeenCalledTimes(1);
  expect(result.ordinary.mode).toBe('ordinary');
});
it('never authenticates when frozen helper enrollment refuses', async () => {
  const f = fixture();
  f.deps.enroll = async () => {
    throw Error('unqualified');
  };
  await expect(applyOfflineRecoveryProposal(f, f.deps)).rejects.toThrow('unqualified');
  expect(f.order).not.toContain('authenticate');
});
it('never restores when no original transaction capsule was produced', async () => {
  const f = fixture();
  f.deps.createTransaction = (args) => ({
    apply: async (authority) => {
      const lease = args.consumeAuthority(authority, args.plan.sha256);
      lease.close();
      return {};
    },
  });
  await expect(applyOfflineRecoveryProposal(f, f.deps)).rejects.toThrow();
  expect(f.order).not.toContain('restore ordinary');
  expect(f.base.close).toHaveBeenCalledTimes(1);
  expect(f.closeAuthorizer).toHaveBeenCalledTimes(1);
});
