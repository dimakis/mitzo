/** Static staging release catalog. Selecting a pin creates no runtime or admission authority. */
import {
  REVIEWED_SYMPOSIUM_OWNED_RUNTIME,
  REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME,
} from './symposium-owned-runtime-contract.js';
/** Explicit successor for Codex code-mode seats. The original image and the
 * Claude variant remain valid for their existing resources; neither migrates. */
export const REVIEWED_SYMPOSIUM_CODE_MODE_RUNTIME = {
  ...REVIEWED_SYMPOSIUM_OWNED_RUNTIME,
  build: {
    ...REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build,
    image: 'sha256:93233f9037f12afadfa1fb17a8ee96aa7e94499366d6977b4859a93fa03e5004',
    imageDigest: '161cde9d0f59c07b3354a0e5c2d863b3796ed81716c728f7eafd4db70ab0dd42',
    nativeArtifacts: {
      ...REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.nativeArtifacts,
      '/usr/bin/codex': '298d3d73d0bbc1367e58a370df5b6216fe30ce0a92e8b6b0afb0377a958dc335',
      '/usr/bin/codex-code-mode-host':
        '7348d1c1cee36270b5599da24ed431e1ac6372666a94bb09e09ef87d1bc9e3b8',
    },
  },
} as const;

/** Measured Codex 0.156.1 successor for fresh Personal Luna 6 seats. */
export const REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME = {
  ...REVIEWED_SYMPOSIUM_OWNED_RUNTIME,
  build: {
    ...REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build,
    image: 'sha256:f3f1f3e6ad517a2055f2a6c3d56f7a03514038abcd8909cc686cc02e3ea96e5f',
    imageDigest: '5bf7f4452c8593b798932bf33d88c7d4f7a02d9a12a6c9d99b467b50fa6232ae',
    nativeArtifacts: {
      ...REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.nativeArtifacts,
      '/usr/bin/codex': '876fe6bb5f7af7d1e4eda629be0d8ba042f6f24a7bb07475f6a995849f50c068',
      '/usr/bin/codex-code-mode-host':
        'b22553f5085d1b2ad5b1d5e935bb8974e2e76d925df1fc30fa83f67bfe216623',
      '/usr/local/bin/symposium-seat-landlock':
        'bf31950c31eafab27d54ddd3662e450769811ea906687616217d743d3134c96d',
    },
  },
} as const;
/** Measured Codex 0.159.1 successor with Luna 6 and Sol 6.1 catalog support. */
export const REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME = {
  ...REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME,
  build: {
    ...REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME.build,
    image: 'sha256:8d228fc4836797a00e09b48166cbeb35e0847aba76b5ef9ff796e0d1c9ae081a',
    imageDigest: '19f5e8c3c4eb660a94cd154740ceda3e05abea86b4107a62540a3daadf08dbff',
    nativeArtifacts: {
      ...REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME.build.nativeArtifacts,
      '/usr/bin/codex': '22c787768933ff4d97e62e2d4613e1671e18b6a2cc999f0666be544acecffa45',
      '/usr/bin/codex-code-mode-host':
        'd2f036fd6adc398a1f87a2458c3726558c2eb5660e73dc2b4b4a6b25241c6178',
    },
  },
} as const;
/** Measured private account-identity bootstrap. Retained opaque-only images are
 * preserved; only this successor consumes a receipt-bound stdin preface. */
export const REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME = {
  ...REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME,
  build: {
    ...REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME.build,
    image: 'sha256:3c40c75d441addde40441c89479e6b982735bba16ef7493a552c8450557a632c',
    imageDigest: '3e2c2338debf745e6f20dbbd6663e19b0243434e309471fb3b698a02a3dab856',
    subscriptionIdentityProtocol: 'stdin-v1',
    nativeArtifacts: {
      ...REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME.build.nativeArtifacts,
      '/usr/local/bin/symposium-subscription-app-server':
        '9bb569cf68df23e8f98c6a2dc2e915f49aa1ddf86a5914539434222907a7cbda',
    },
  },
} as const;
export function reviewedStagingOwnedRuntime(image: string) {
  if (image === REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.image)
    return REVIEWED_SYMPOSIUM_OWNED_RUNTIME;
  if (image === REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build.image)
    return REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME;
  if (image === REVIEWED_SYMPOSIUM_CODE_MODE_RUNTIME.build.image)
    return REVIEWED_SYMPOSIUM_CODE_MODE_RUNTIME;
  if (image === REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME.build.image)
    return REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME;
  if (image === REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME.build.image)
    return REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME;
  if (image === REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME.build.image)
    return REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME;
  throw new Error('Artifact workload image identity is not reviewed');
}
