import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';
it('pins the full secret relay host boundary and verifies all reviewed source hashes', () => {
  for (const file of [
    'secret-relay',
    'secret-relay-lan',
    'secret-relay-mqtt',
    'secret-relay-browser',
    'secret-relay-browser-driver',
    'secret-relay-runtime',
    'openshell-secret-vault',
    'openshell-secret-protocol',
    'openshell-operator-transport',
  ])
    expect(Object.hasOwn(reviewedHandlerSourceArtifacts, `../${file}.ts`)).toBe(true);
  for (const [file, hash] of Object.entries(reviewedHandlerSourceArtifacts)) {
    const source = readFileSync(new URL(`../connections/${file}`, import.meta.url), 'utf8');
    expect(reviewedHandlerSourceFingerprint(source), file).toBe(hash);
  }
});
