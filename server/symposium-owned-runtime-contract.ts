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
