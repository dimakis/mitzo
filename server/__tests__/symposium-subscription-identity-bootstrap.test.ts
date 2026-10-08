import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('validates the versioned identity bootstrap offline without native or model calls', () => {
  expect(() =>
    execFileSync(
      'python3',
      ['-I', '-B', resolve('docs/spikes/openshell-codex/test_symposium_subscription_identity.py')],
      {
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
  ).not.toThrow();
});

it('adds only the versioned bootstrap to the immutable 0.159.1 measurement base', () => {
  const source = readFileSync(
    resolve('docs/spikes/openshell-codex/Dockerfile.codex-0.159.1-identity-measure'),
    'utf8',
  );
  expect(source).toContain(
    'sha256:8d228fc4836797a00e09b48166cbeb35e0847aba76b5ef9ff796e0d1c9ae081a',
  );
  expect(source).toContain(
    'COPY docs/spikes/openshell-codex/symposium-subscription-identity-app-server /usr/local/bin/symposium-subscription-app-server',
  );
  expect(source).toContain('chmod 0755 /usr/local/bin/symposium-subscription-app-server');
  expect(source.trim().endsWith('USER sandbox')).toBe(true);
});
