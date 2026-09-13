import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { findRollout } from './local-checkpoint-rollout.mjs';

test('discovers a rollout by session metadata across date directories without a year assumption', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-rollout-discovery-'));
  try {
    const old = join(root, '2025', '12', '31');
    const current = join(root, '2026', '01', '01');
    mkdirSync(old, { recursive: true });
    mkdirSync(current, { recursive: true });
    writeFileSync(
      join(old, 'rollout-wrong.jsonl'),
      '{"type":"session_meta","payload":{"id":"other"}}\n',
    );
    const expected = join(old, 'rollout-match.jsonl');
    writeFileSync(expected, '{"type":"session_meta","payload":{"id":"thread"}}\n');
    writeFileSync(
      join(current, 'rollout-later.jsonl'),
      '{"type":"session_meta","payload":{"id":"thread"}}\n',
    );

    const rollout = findRollout(root, 'thread');

    assert.equal(rollout?.path, expected);
    assert.equal(rollout?.metadata.payload.id, 'thread');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores non-rollout files and mismatched rollout metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-rollout-discovery-'));
  try {
    const day = join(root, '2027', '02', '03');
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, 'session.jsonl'),
      '{"type":"session_meta","payload":{"id":"thread"}}\n',
    );
    writeFileSync(
      join(day, 'rollout-other.jsonl'),
      '{"type":"session_meta","payload":{"id":"other"}}\n',
    );

    assert.equal(findRollout(root, 'thread'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('caps rollout header inspection', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-rollout-discovery-'));
  try {
    const day = join(root, '2028', '03', '04');
    mkdirSync(day, { recursive: true });
    for (let index = 0; index <= 1024; index++)
      writeFileSync(
        join(day, `rollout-${String(index).padStart(4, '0')}.jsonl`),
        '{"type":"session_meta","payload":{"id":"other"}}\n',
      );

    assert.throws(() => findRollout(root, 'thread'), /too many rollout candidates/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
