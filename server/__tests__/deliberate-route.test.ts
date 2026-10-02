import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliberateRouteRevision } from '../deliberate-route.js';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deliberate-route-'));
  vi.stubEnv('CLOUDSDK_CONFIG', dir);
  vi.stubEnv('CLOUDSDK_ACTIVE_CONFIG_NAME', 'test');
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', join(dir, 'adc.json'));
  mkdirSync(join(dir, 'configurations'));
  writeFileSync(join(dir, 'configurations', 'config_test'), '[core]\naccount = one@example.test');
  writeFileSync(join(dir, 'adc.json'), '{"client_email":"one@example.test"}');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
it.each([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLOUDSDK_CORE_ACCOUNT',
])('binds %s without exposing its value', (key) => {
  vi.stubEnv(key, 'private-one');
  const before = deliberateRouteRevision();
  vi.stubEnv(key, 'private-two');
  expect(deliberateRouteRevision()).not.toBe(before);
  expect(before).toMatch(/^[0-9a-f]{64}$/);
});
it.each(['adc.json', 'configurations/config_test'])('detects identity change in %s', (file) => {
  const before = deliberateRouteRevision();
  writeFileSync(join(dir, file), 'different identity');
  expect(deliberateRouteRevision()).not.toBe(before);
});
it('binds gcloud credential-file overrides by content', () => {
  const file = join(dir, 'override.json');
  vi.stubEnv('CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', file);
  writeFileSync(file, 'identity-one');
  const before = deliberateRouteRevision();
  writeFileSync(file, 'identity-two');
  expect(deliberateRouteRevision()).not.toBe(before);
});
