import { describe, expect, it } from 'vitest';
import { OwnedSymposiumGateway } from '../symposium-owned-gateway.js';
import { captureQualifiedNativeInferenceCurrentAuthentication } from '../staging-native-inference-current-auth.js';
describe('native current authentication requires an actual original gateway constructor', () => {
  it('refuses copied JSON and a forged gateway prototype without opening transport', () => {
    expect(() =>
      captureQualifiedNativeInferenceCurrentAuthentication({} as OwnedSymposiumGateway),
    ).toThrow();
    expect(() =>
      captureQualifiedNativeInferenceCurrentAuthentication(
        Object.create(OwnedSymposiumGateway.prototype),
      ),
    ).toThrow();
  });
});
