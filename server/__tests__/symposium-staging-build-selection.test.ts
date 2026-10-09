import { expect, it } from 'vitest';
import * as staging from '../symposium-staging-runtime-contract.js';
import {
  SOURCE_QUALIFIED_SYMPOSIUM_ROUTING_BUILD as routing,
  REVIEWED_SYMPOSIUM_OWNED_RUNTIME,
  REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME,
} from '../symposium-owned-runtime-contract.js';

const config = (build: {
  cliSha256: string;
  gatewaySha256: string;
  image: string;
  sandboxRuntimeImage: string;
  supervisorImage: string;
}) => ({
  cliSha256: build.cliSha256,
  executableSha256: build.gatewaySha256,
  workloadImage: build.image,
  sandboxRuntimeImage: build.sandboxRuntimeImage,
  supervisorImage: build.supervisorImage,
});
const classify = (gateway: ReturnType<typeof config>) => staging.reviewedStagingOwnedBuild(gateway);

it('preserves original serialized build identity and selects only the exact routing tuple', () => {
  for (const runtime of [
    REVIEWED_SYMPOSIUM_OWNED_RUNTIME,
    REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME,
    staging.REVIEWED_SYMPOSIUM_CODE_MODE_RUNTIME,
    staging.REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME,
    staging.REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME,
    staging.REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME,
  ]) {
    const original = staging.reviewedStagingOwnedRuntime(runtime.build.image).build;
    expect(classify(config(original))).toBe(original);
    expect(Object.keys(original)).not.toContain('gatewayVersion');
  }
  expect(classify(config(routing))).toBe(routing);
});
it.each([
  'cliSha256',
  'executableSha256',
  'workloadImage',
  'sandboxRuntimeImage',
  'supervisorImage',
] as const)('refuses routing %s drift and missing pins', (key) => {
  const gateway = config(routing);
  expect(() => classify({ ...gateway, [key]: 'unreviewed' })).toThrow('Staging native tuple');
  expect(() => classify({ ...gateway, [key]: undefined } as never)).toThrow('Staging native tuple');
});
it('refuses mixed original/routing pins in either direction', () => {
  const original = staging.REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME.build;
  expect(() => classify({ ...config(original), cliSha256: routing.cliSha256 })).toThrow(
    'Staging native tuple',
  );
  expect(() => classify({ ...config(routing), supervisorImage: original.supervisorImage })).toThrow(
    'Staging native tuple',
  );
});
