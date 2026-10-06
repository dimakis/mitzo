import { afterEach, expect, it, vi } from 'vitest';
import { buildSdkChildEnvironment } from '../chat.js';
afterEach(() => vi.unstubAllEnvs());
it('keeps controller publishing credentials available to the controller and out of legacy SDK children', () => {
  vi.stubEnv('GH_TOKEN', 'controller-publisher');
  vi.stubEnv('GITHUB_TOKEN', 'controller-fallback');
  const child = buildSdkChildEnvironment();
  expect(child.GH_TOKEN).toBeUndefined();
  expect(child.GITHUB_TOKEN).toBeUndefined();
  expect(child.PATH).toBeTruthy();
  expect(process.env.GH_TOKEN).toBe('controller-publisher');
  expect(process.env.GITHUB_TOKEN).toBe('controller-fallback');
});
