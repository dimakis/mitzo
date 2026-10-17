import { expect, it } from 'vitest';
import { summarizeSandboxInventory } from '../sandbox-inventory.js';

it('counts every physical sandbox once and exposes sandboxes absent from the ledger', () => {
  const physical = [
    { id: 'one', name: 'managed', phase: 'Ready' },
    { id: 'two', name: 'legacy', phase: 'Stopped' },
    { id: 'three', name: 'spare', phase: 'Ready' },
    { id: 'four', name: 'failed', phase: 'Error' },
  ];
  const result = summarizeSandboxInventory(
    [...physical, physical[0]!],
    [{ physicalId: 'one', sandboxName: 'managed' }],
    [{ physicalId: 'three', name: 'spare' }],
  );
  expect(result.total).toBe(4);
  expect(result.counts).toEqual({ Ready: 2, Stopped: 1, Error: 1 });
  expect(result.items.map((r) => r.management)).toEqual([
    'conversation',
    'needs_review',
    'spare',
    'needs_review',
  ]);
});
it('never treats a recycled name or a missing physical identity as managed', () => {
  const result = summarizeSandboxInventory(
    [{ id: 'replacement', name: 'managed', phase: 'Ready' }],
    [{ physicalId: 'old', sandboxName: 'managed' }],
    [],
  );
  expect(result.items[0]?.management).toBe('needs_review');
});
