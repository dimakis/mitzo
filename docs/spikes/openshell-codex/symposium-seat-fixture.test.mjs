import assert from 'node:assert/strict';
import test from 'node:test';

import { createSymposiumFixture } from './symposium-seat-fixture.mjs';

test('keeps seat bindings and model context separate in one shared workspace', async () => {
  const symposium = createSymposiumFixture();

  const result = await symposium.run();

  assert.deepEqual(result.builder.received, ['shared-objective', 'builder-only-plan']);
  assert.deepEqual(result.reviewer.received, ['shared-objective', 'review-package']);
  assert.equal(result.reviewer.workspace, 'symposium-shared');
  assert.equal(result.builder.workspace, 'symposium-shared');
  assert.equal(result.builder.account, 'chatgpt-subscription');
  assert.equal(result.reviewer.account, 'vertex');
  assert.equal(result.transcript[0].seat, 'builder');
  assert.equal(result.transcript[0].deliveredTo, 'reviewer');
  assert.equal(result.transcript[0].original, 'builder draft');
  assert.equal(result.transcript[0].delivered, 'redacted finding request');
});
