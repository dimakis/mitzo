import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VertexAdcCustody } from '../ordinary-local-vertex-custody.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vertex-adc-offline-')));
  roots.push(root);
  chmodSync(root, 0o700);
  const adc = join(root, 'adc.json');
  writeFileSync(
    adc,
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'offline-id',
      client_secret: 'offline-secret',
      refresh_token: 'offline-token',
      quota_project_id: 'fixture-project',
    }),
    { mode: 0o600 },
  );
  const env = {
    CLAUDE_CODE_USE_VERTEX: '1',
    ANTHROPIC_VERTEX_PROJECT_ID: 'fixture-project',
    CLOUD_ML_REGION: 'fixture-region',
    GOOGLE_APPLICATION_CREDENTIALS: adc,
  };
  return { root, adc, env };
}
it('captures exact private ADC and project/region authority without exposing credential contents in custody', () => {
  const { adc, env } = fixture();
  const custody = VertexAdcCustody.capture(env);
  custody.assertCurrent(env);
  expect(JSON.stringify(custody.snapshot())).not.toContain('offline-secret');
  expect(JSON.stringify(custody.snapshot())).not.toContain('offline-token');
  expect(custody.snapshot()).toMatchObject({
    project: 'fixture-project',
    region: 'fixture-region',
    adc: { path: adc },
  });
});
it('refuses token refresh, inode replacement, project/region drift and credential fallbacks', () => {
  const { adc, env } = fixture();
  const custody = VertexAdcCustody.capture(env);
  expect(() => custody.assertCurrent({ ...env, CLOUD_ML_REGION: 'different' })).toThrow();
  expect(() =>
    custody.assertCurrent({ ...env, GOOGLE_APPLICATION_CREDENTIALS: undefined }),
  ).toThrow();
  const replacement = adc + '.replacement';
  writeFileSync(
    replacement,
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'offline-id',
      client_secret: 'offline-secret',
      refresh_token: 'offline-token',
      quota_project_id: 'fixture-project',
    }),
    { mode: 0o600 },
  );
  renameSync(replacement, adc);
  expect(() => custody.assertCurrent(env)).toThrow();
  const current = VertexAdcCustody.capture(env);
  writeFileSync(
    adc,
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'offline-id',
      client_secret: 'offline-secret',
      refresh_token: 'changed',
      quota_project_id: 'fixture-project',
    }),
  );
  expect(() => current.assertCurrent(env)).toThrow();
});
it('refuses non-private ADC and unrelated authentication controls', () => {
  const { adc, env } = fixture();
  chmodSync(adc, 0o644);
  expect(() => VertexAdcCustody.capture(env)).toThrow();
  chmodSync(adc, 0o600);
  expect(() => VertexAdcCustody.capture({ ...env, ANTHROPIC_API_KEY: 'offline-other' })).toThrow();
});

it.each([
  { type: 'external_account', audience: 'offline' },
  {
    type: 'authorized_user',
    client_id: 'id',
    client_secret: 'secret',
    refresh_token: 'token',
    universe_domain: 'other.invalid',
  },
  {
    type: 'authorized_user',
    client_id: 'id',
    client_secret: 'secret',
    refresh_token: 'token',
    token_uri: 'https://other.invalid/token',
  },
])('refuses unsupported or redirected ADC authority %j', (value) => {
  const { adc, env } = fixture();
  writeFileSync(adc, JSON.stringify(value));
  expect(() => VertexAdcCustody.capture(env)).toThrow();
});

it.each(['GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'])(
  'refuses ambient project/billing override %s outside the selected ADC authority',
  (key) => {
    const { env } = fixture();
    expect(() => VertexAdcCustody.capture({ ...env, [key]: 'different-project' })).toThrow();
  },
);

it('pins selected ADC quota bytes across reopen and refuses quota-only billing changes', () => {
  const { adc, env } = fixture();
  const custody = VertexAdcCustody.capture(env);
  expect(VertexAdcCustody.reopen(custody.snapshot(), env).snapshot()).toEqual(custody.snapshot());
  writeFileSync(
    adc,
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'offline-id',
      client_secret: 'offline-secret',
      refresh_token: 'offline-token',
      quota_project_id: 'different-billing-project',
    }),
  );
  expect(() => VertexAdcCustody.reopen(custody.snapshot(), env)).toThrow();
});
