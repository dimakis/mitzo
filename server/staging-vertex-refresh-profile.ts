import { createHash } from 'node:crypto';
import {
  captureOriginalStagingNativeBootstrap,
  type StagingNativeFeatureBootstrap,
} from './staging-native-feature-bootstrap.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';

/** Reviewed source bytes only. The digest is not an enrollment/model grant. */
export const STAGING_VERTEX_PROFILE_SHA256 =
  '0bb081c7a0f651d7a15cca6008d588c747ef3a40306a48a083334eab537698b2';
export const STAGING_VERTEX_AUTH_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
]);
export interface StagingVertexRefreshProfile {
  readonly profileId: 'google-vertex-ai';
  readonly profileWorkspace: string;
  readonly profileSha256: string;
}
type Input = Readonly<{ bootstrap: StagingNativeFeatureBootstrap; ownerInstance: string }>;
const originals = new WeakMap<
  StagingVertexRefreshProfile,
  {
    gateway: OwnedSymposiumGateway;
    assertCurrent(): void;
  }
>();
const refuse = () => Error('Original reviewed staging Vertex refresh profile unavailable');
/** Actual configured-host construction invokes this only after its fixed
 * workspace import. The real bootstrap brand, unchanged source bytes and same
 * retained gateway remain required; JSON/profile labels cannot mint the port. */
export function captureStagingVertexRefreshProfile(
  input: Input,
  gateway: OwnedSymposiumGateway,
  importedBytes: Buffer,
): StagingVertexRefreshProfile {
  const original = captureOriginalStagingNativeBootstrap(input.bootstrap);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.ownerInstance) ||
    gateway.workspace === 'default' ||
    !gateway.workspace ||
    createHash('sha256').update(importedBytes).digest('hex') !== STAGING_VERTEX_PROFILE_SHA256
  )
    throw refuse();
  const assertCurrent = () => {
    original.assertCurrent();
    gateway.verifyCustody();
    original.assertCurrent();
  };
  assertCurrent();
  const capability = Object.freeze({
    profileId: 'google-vertex-ai' as const,
    profileWorkspace: gateway.workspace,
    profileSha256: STAGING_VERTEX_PROFILE_SHA256,
  });
  originals.set(capability, { gateway, assertCurrent });
  return capability;
}
export function assertStagingVertexRefreshProfile(
  capability: StagingVertexRefreshProfile,
  gateway: OwnedSymposiumGateway,
): void {
  const original = originals.get(capability);
  if (
    !original ||
    original.gateway !== gateway ||
    gateway.workspace !== capability.profileWorkspace
  )
    throw refuse();
  original.assertCurrent();
}
