import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import type { StagingNativeSandboxGuard } from './staging-native-model-authority.js';
import {
  captureQualifiedNativeInferenceCurrentAuthentication,
  type NativeInferenceCurrentRequest,
  type NativeInferenceCurrentEnvelope,
} from './staging-native-inference-current-auth.js';

export interface OriginalNativeInferenceRun {
  readonly runId: string;
  readonly planSha256: string;
  readonly acceptedAppCommit: string;
  readonly nativeSourceCommit: string;
  readonly ownerInstance: string;
  readonly sessionId: string;
  readonly claimToken: string;
  readonly sandboxName: string;
  assertCurrent(): void;
  assertCleanupCurrent(): void;
}

/** Constructed only inside the original native host's actual feature factory.
 * The HTTP route has no registration, binding or adoption operation. Signed
 * metadata is checked against these retained source-owned objects, then the
 * same original queue/lifecycle closure runs before the one-use response. */
export class StagingNativeInferenceCurrentOwner {
  private readonly guards = new Map<
    string,
    { run: OriginalNativeInferenceRun; guard: StagingNativeSandboxGuard; sandboxId?: string }
  >();
  constructor(private readonly gateway: OwnedSymposiumGateway) {}

  registerGuard(run: OriginalNativeInferenceRun, guard: StagingNativeSandboxGuard): void {
    run.assertCurrent();
    guard.assertCurrent();
    if (this.guards.size >= 100 || this.guards.has(guard.guardId))
      throw Error('Original native inference guard registration unavailable');
    this.guards.set(guard.guardId, { run: Object.freeze({ ...run }), guard });
  }

  bindSandbox(guard: StagingNativeSandboxGuard, sandboxId: string): void {
    const original = this.guards.get(guard.guardId);
    if (!original || original.guard !== guard || !sandboxId || original.sandboxId)
      throw Error('Original native inference sandbox binding unavailable');
    original.run.assertCurrent();
    guard.assertCurrent();
    original.sandboxId = sandboxId;
  }

  current(
    meta: { method: string; url: string },
    envelope: unknown,
  ): NativeInferenceCurrentEnvelope {
    // Capture is deliberately refused until the actual native producer/build
    // and original gateway constructor retain a qualified authentication port.
    const authentication = captureQualifiedNativeInferenceCurrentAuthentication(this.gateway);
    const request = authentication.verifyRequest(meta, envelope);
    const original = this.guards.get(request.guardId);
    if (!original || !this.matches(original.run, request))
      throw Error('Actual original native inference run unavailable');
    if (request.phase !== 'prepare' && request.sandboxId !== original.sandboxId)
      throw Error('Actual original native inference sandbox differs');
    // Supervisor session and wire identity are authenticated by the qualified
    // native gateway producer against actual SandboxJWT/ConnectSupervisor and
    // final wire. Codec JSON alone cannot qualify either identity.
    if (request.phase === 'complete' || request.phase === 'revoke')
      original.run.assertCleanupCurrent();
    else original.run.assertCurrent();
    return authentication.signResponse(request, { kind: 'current' });
  }

  private matches(
    run: OriginalNativeInferenceRun,
    request: NativeInferenceCurrentRequest,
  ): boolean {
    return (
      run.runId === request.runId &&
      run.planSha256 === request.planSha256 &&
      run.acceptedAppCommit === request.acceptedAppCommit &&
      run.nativeSourceCommit === request.nativeSourceCommit &&
      run.ownerInstance === request.ownerInstance &&
      run.sessionId === request.sessionId &&
      run.claimToken === request.claimToken &&
      run.sandboxName === request.sandboxName
    );
  }
}
