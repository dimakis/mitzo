/** Reviewed owned Symposium runtime, separate from the legacy production stack lock.
 * Pins change only with physical evidence and an explicit migration decision.
 * This data-only module must not import operation helpers or admission services. */
export const REVIEWED_SYMPOSIUM_OWNED_RUNTIME = {
  build: {
    version: '0.0.117-dev.292+g854b2370b',
    cliSha256: '5a02cb78ef641da6badec1901677d4478c059a0080dbf4de13a6bbc503588dc8',
    gatewaySha256: '281a4873ec62ddb384db2b495a324d5a899e27944500c309191195463cd2422e',
    image: 'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161',
    imageDigest: '55b6dc5c7aaf443c4a11c44d29a170697648e63f3b8f81f7e1e93b7535e9fe17',
    sandboxRuntimeImage: 'sha256:ea1fa3016afc3029d5cef331a92f3fb1383f03799221aec920248d06f4aba1dd',
    supervisorImage: 'sha256:8df2e97c2b25b75031b4c00cb49e4cd487ba2384ebe7d884a0aa12095be20937',
    nativeArtifacts: {
      '/usr/bin/codex': '4d76e542c222ea8c75861d8c4ade60a1a332a63255ce1c60bdaebf7c2a2869e6',
      '/usr/local/bin/symposium-attempt-controller':
        'd9f995cd0871ca63be4efa3c5d5760094af9c07496e1acf5d838acf8b55f2209',
      '/usr/local/bin/symposium-seat-landlock':
        '286c37e476c145df22216402310b20ac7a7ac735d6280a1293b800299b76801f',
      '/usr/local/bin/symposium-subscription-app-server':
        'ffb14857502305d354143e475ad8b417aa733857254b6d3e34b66023e444adfb',
    },
  },
  workload: {
    // OCI USER sandbox, physically verified for this exact workload image.
    uid: 998,
    gid: 998,
    workdir: '/sandbox/workspaces/mgmt',
  },
} as const;

/** Separately measured Claude-capable variant. The original Codex build above
 * remains accepted verbatim; existing resources are never migrated implicitly. */
export const REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME = {
  ...REVIEWED_SYMPOSIUM_OWNED_RUNTIME,
  build: {
    ...REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build,
    image: 'sha256:df8fd2214ee37f8a306ce98ad722f766f4d5c343ce4e8eda023fdbbc5ab92e47',
    imageDigest: '05ab31eaa28ac9535456f454a39c351d4673bd1d6df024caf17843f65cf77432',
    nativeArtifacts: {
      ...REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.nativeArtifacts,
      '/usr/local/bin/symposium-seat-landlock':
        '2a32470d6854637311cb790553b5c251a46176dced12eb6568f7582852500c34',
      '/usr/local/bin/claude': '7ed95d0a93aeb40e2b98e234b760d9295b7044ef678c62db8d1f5e14bfd57878',
      '/usr/local/bin/symposium-claude-vertex':
        'd9cefeef981bc0927b1bd954f358671329ad18488460cc6074a13a0bb634ef5e',
    },
  },
} as const;

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
export function reviewedSymposiumOwnedRuntime(image: string) {
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

/** Explicit source-qualified local build, not a claim of completed physical admission.
 * Image-only consumers retain their original catalog entry. Only trusted construction
 * can select this exact tuple before the same physical gate collects evidence. */
export type SymposiumOwnedBuildSelection = 'local-854b-b20-v1';
export const SOURCE_QUALIFIED_SYMPOSIUM_LOCAL_B20_BUILD = Object.freeze({
  ...REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME.build,
  version: '0.0.0',
  cliSha256: '6ed96b7aa13655d6ecaeb822aee7526bc2170d85bd00f4506b13330703cb5dff',
  gatewaySha256: '712906577a63c29553e7f2653bf2944c55a7142c3c69643532d1461da1eebe10',
  supervisorImage: 'sha256:baa239a3c804bb889d70f8da465facbe289e302fba4cefb19112200a16fb5013',
  nativeArtifacts: Object.freeze({
    ...REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME.build.nativeArtifacts,
  }),
} as const);
export function reviewedSymposiumOwnedBuild(
  image: string,
  selection?: SymposiumOwnedBuildSelection,
) {
  const original = reviewedSymposiumOwnedRuntime(image).build;
  if (selection === undefined) return original;
  if (
    selection !== 'local-854b-b20-v1' ||
    image !== SOURCE_QUALIFIED_SYMPOSIUM_LOCAL_B20_BUILD.image
  )
    throw Error('Owned full-build selection is not reviewed');
  return SOURCE_QUALIFIED_SYMPOSIUM_LOCAL_B20_BUILD;
}
