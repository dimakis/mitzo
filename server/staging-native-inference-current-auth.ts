import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import type {
  NativeInferenceCurrentEnvelope,
  NativeInferenceCurrentRequest,
} from './staging-native-inference-current-codec.js';
export type {
  NativeInferenceCurrentEnvelope,
  NativeInferenceCurrentRequest,
  NativeInferenceCurrentResponse,
} from './staging-native-inference-current-codec.js';

export interface NativeInferenceCurrentAuthentication {
  verifyRequest(
    meta: { method: string; url: string },
    envelope: unknown,
  ): Readonly<NativeInferenceCurrentRequest>;
  /** Only the same verified one-use object, after the actual registered run's
   * original private queue assertion. JSON cannot reconstruct this object. */
  signResponse(
    request: Readonly<NativeInferenceCurrentRequest>,
    result: { kind: 'current' },
  ): NativeInferenceCurrentEnvelope;
}

/** No setter or JSON registration exists. The original gateway constructor
 * retains the source-qualified native transport, when that producer has been
 * rebuilt, independently reviewed, and installed into its actual launch. */
export function captureQualifiedNativeInferenceCurrentAuthentication(
  gateway: OwnedSymposiumGateway,
): NativeInferenceCurrentAuthentication {
  return gateway.captureNativeInferenceCurrentAuthentication();
}
