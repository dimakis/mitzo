import { expect, it } from 'vitest';
import { requireCustodianOrdinaryRuntime } from '../custodian-ordinary-runtime.js';
import { custodianAppEnvironment } from '../symposium-custodian-launch.js';
import { openShellRuntimeConfig } from '../openshell-runtime.js';
const explicit = {
  MITZO_OPENSHELL_ENABLED: '1',
  MITZO_OPENSHELL_IMAGE: 'reviewed-ordinary-image',
  MITZO_OPENSHELL_POLICY: '/ordinary/policy.yaml',
  MITZO_OPENSHELL_SEED: '/ordinary/seed',
  MITZO_OPENSHELL_CLI: '/ordinary/openshell',
  MITZO_OPENSHELL_GATEWAY_ENDPOINT: 'https://ordinary.example.test',
  OPENSHELL_GATEWAY: 'ordinary',
  OPENSHELL_WORKSPACE: 'ordinary-workspace',
};
it.each(['openai', 'openai-codex'])(
  'preserves a valid explicit %s sandbox route through child configuration',
  (provider) => {
    const child = custodianAppEnvironment(explicit);
    expect(() => requireCustodianOrdinaryRuntime(true, provider, child)).not.toThrow();
    expect(openShellRuntimeConfig(child)).toMatchObject({
      image: explicit.MITZO_OPENSHELL_IMAGE,
      policy: explicit.MITZO_OPENSHELL_POLICY,
      seed: explicit.MITZO_OPENSHELL_SEED,
      gateway: 'ordinary',
      workspace: 'ordinary-workspace',
      gatewayEndpoint: explicit.MITZO_OPENSHELL_GATEWAY_ENDPOINT,
    });
  },
);
it.each([
  {},
  { ...explicit, MITZO_OPENSHELL_ENABLED: '0' },
  { ...explicit, MITZO_OPENSHELL_SANDBOX_NAME: 'legacy' },
  { ...explicit, MITZO_OPENSHELL_OPENAI_API_ENABLED: '0' },
  { ...explicit, MITZO_OPENSHELL_POLICY: '' },
])('fails closed for unavailable or host-selected controller routing', (env) => {
  expect(() => requireCustodianOrdinaryRuntime(true, 'openai', env)).toThrow();
});
it('does not change ordinary unsplit behavior or non-OpenAI providers', () => {
  expect(() => requireCustodianOrdinaryRuntime(false, 'openai', {})).not.toThrow();
  expect(() => requireCustodianOrdinaryRuntime(true, 'anthropic-vertex', {})).not.toThrow();
});
