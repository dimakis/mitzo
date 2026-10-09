import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.0';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.6';

/** Runtime admission changes without changing existing provider policy semantics. */
export const reviewedConnectionsRuntimeImplementationRevision = 'v1.0.13';

export function reviewedHandlerSourceFingerprint(source: string) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Generated during an intentional reviewed handler revision. These hash the
 * complete source modules containing compiler/probe/executor semantics, not
 * just fixtures. The build check verifies them on every server build.
 */
export const reviewedHandlerSourceArtifacts = Object.freeze({
  '../credential-websocket.ts': '87a41d7c329dccb6616726feed14a5fb25c8aefe94556c767f42618b8d995810',
  // Keychain HTTP/WebSocket credential custody and exact-session approval handlers.
  '../home-assistant-dashboard.ts':
    '1053d482935af066472aedd48365af2b71cb7cf55e30ee88cc9fcf89b96e1d62',
  '../credential-connections.ts':
    '45506bed1fbbba4b1044cee49157bc8ff05812481a031796b69067477f7473df',
  '../credential-connections-router.ts':
    'b05c419d959bb8e5b8523e603ab090a15bbd25dc9d3295bf6b1ad139a9899e65',
  '../credential-connection-tools.ts':
    '5834050754b87751a15a6198f5409249276d675e2d1cc2a08be2a646b8396a1c',
  '../credential-connections-runtime.ts':
    '89a1cdf4bd50c73a0aecfb966303fb37e0f524da9fb977478602c9c198a51b4d',
  '../credential-http.ts': 'fb584d92840e2ee34167fd354d7249cfb3144b321f0d3a0a4aad3015231fa22d',
  '../credential-redaction.ts': '817dda948c419deb064bc4c5298e034e5a0343972b4bf724fb6aaa869cf34403',
  '../credential-sdk-tools.ts': 'e64cae00d86986bba78e672ad9ebf6c8c89316e2e64bb30c7d478f76fc1640c9',
  '../session-credential-tools.ts':
    '70db62d9e3c16e66c2e238351a348b82fc6afc8f3b7baba37eeaabb98d27b9c8',
  'policy-compiler.ts': '13a12a3182568a151247cb204792f15c374af9e5a7f401d51b954c6dd40fd538',
  'registry.ts': 'cccbb1c67d559eda923c4d0beac5e0203918e3ab2970ab90a1937bb32a09d8a4',
  'iana-address-policy.ts': '899b0b5ad66f5cbe72224b34c29ff7a88e32c2a6f5b2987e4d18cfc64f862b4e',
  'iana-address-data.generated.ts':
    '58f91383fa17ab9612d24bc113d011ece63bfc06b4635ba99f108bb05aa34038',
  // The capability binding is not trusted merely because its manifest is
  // reviewed: both the production executor and its OpenShell/Git transport
  // must match this revision before the registry can advertise the action.
  'capabilities/github-publish-pr.ts':
    '5c89cde9110fa132ea94cd5ec0dd531ce47d668450ab4a869ad5e420cd1929f9',
  'capabilities/github-publish-pr-transport.ts':
    'd333da15bfd6d9bc9f41ec68bd93a48b644415d5911080aa4c79f029b47831e8',
  '../github-host-source.ts': '8e3ec9f30b300d7509124f59b969e5b059d5662b710a3a90f228cc86f08ac7e3',
  '../github-publishing-tool.ts':
    'db6746ef09c51d46617dc413b7faea8a0ab412b9c0c60870d18f8bd66fd94e11',
  '../capability-conversation-binding.ts':
    '147a328d161f167aeeb31bf0017d5fea25cc3f22933392249a228d7bd61e89aa',
  // Secret custody and its browser/admission boundaries share the runtime review contract.
  '../openai-key-management.ts': '1ec5481e02e9803007d7452abd0b6167e94e54249bc633a1b5edc47054129d3b',
  '../openai-key-operation-store.ts':
    'dcd4bfc37e6098f194e19c9a797ca70eed189b19568c0272c778ecdec49f00a9',
  '../openai-enrollment-models.ts':
    '11a318042fbd8f7aecc09563c80456bfff424813a3d12a05d01bc768a0358263',
  '../openai-account-enrollment.ts':
    '610827421850db26976f2e9a6c8552ea984e0b9bbd61621573fdb0f8fb0847f6',
  '../openai-account-enrollment-keychain.ts':
    '2e75b1031b0006ef98334deef8a53890627af337c0fef8602de6e15b72c3b9d5',
  '../openai-provider-enrollment-gateway.ts':
    '55f91240860c2f15d60a9fa491374cf74f30e06a4dbf75ec5ce6f321b9815991',
  '../openshell-key-api.ts': '45164e44c19a0d1c845a847ea3ccae625445d75c3d09fa32ca5ec86dd53e26a3',
  '../openshell-key-api-protocol.ts':
    '3ebca322e76e76771aaffbccabeda9ea1bb2945d672d9f9879d2665b584ca423',
  '../openai-key-gateway.ts': '995b4baf93843de1bc3e12b8a6be34d40f3937a5ffaea8b4f6cef2a64ab475c1',
  '../keychain-rotation-credentials.ts':
    'c2d94ede80f5950b45568dc41c5d10c20802d4504dbcd0b6657e8de04de72d4a',
  '../openai-key-controller.ts': '721a1c6a513fc5380e4a2222927cda025bf8cbd7e8d49d8c5d526470e2cff217',
  '../connections-router.ts': 'db03601e5f09080ad370621d2fcbd5879f744c9b272a930b296c20cd47f82979',
  '../connections-service.ts': '1aae9d2c0da483ae798ba03d5804bfb0e81316f3f69666c6595befec3179c314',
  // Repository acquisition and source claims share the ordinary runtime admission review.
  '../github-repository-source.ts':
    '2b05c5b3e3c0b93d299d355fffa714fe64f000f478ab612ab0c3915ff5cb6d6c',
  '../worktree.ts': 'e3fd6d93d33cb5403786c5a7da16dd229d8ba03ad06e8c3abaf6309c64adb34a',
  '../repository-task-checkout.ts':
    '32fd232781b0ba9573fa0e6a511a78ede54a8c33a80dee30f52d06283b4beab5',
  '../native-tool-executor.ts': '6bca4beb98690334e83a0a88b35c80558ed01b7485f682aca0cc0af11b6cd766',
  '../repository-workspaces.ts': '36875ad74d8c31111003201c684bf9db98b999e36ff4ebc3e36ddfcd91d80617',
  '../repository-workspace-runtime.ts':
    'b6d4516dd289d2c40d34d32adde3aa3d3cd24405706e1b720f8dffb3ff0c32e4',
  '../repository-workspace-router.ts':
    '13b8fab1dd0f5b83abfbb06946533cfb5273d28e4a71aacd24f7076be4858905',
  '../trusted-native-operation.ts':
    '0e8afb3b0968881d542850c68b5bc3cb362becffb47e354eccf8375e52ff0038',
  '../repository-chat-startup.ts':
    'da5476aa7e43badb1809a8f52d958d5338ec921c6ab96531978f750fecf4428f',
  // Admission shares compiled connection authority with gateway provisioning.
  'runtime-profiles.ts': '3632545ca52fbfad7442de08c03d5f9808b50b5bfdef92f9cd72b8fa8ab5140b',
  '../connections-gateway.ts': '8cc83813dff18a0cafba0fad53f3c5de987c8af631f8439029590285501849a1',
  '../openshell-runtime-policy.ts':
    'efecd458bf61fecd8198ecd330e0227e2c600ab21d6d2890cd2bac254e22b75f',
  '../openshell-runtime.ts': '71e650b8114df6264ce0a5b81ae32a1907ee3562c177c9d0d59c1f4825849b0c',
  '../codex-chat-session.ts': 'c02f0cc99dff1d5ed289941a5d25cfb7044c9a507194bebf345b7f0b422555dc',
  '../connections-runtime.ts': 'dbe641704a1d761d73740260fb28057054fdb34a64513fa77292d2fdb1954a84',
  'capabilities/operation-store.ts':
    '1a235f11d5578880e6dfa7ecf5779e2a011e24430774fc17429d7d22359b93f2',
  'capabilities/service.ts': '848e0998848d68e80ec53731b248a286f77f761905082092821f3ec9047ba36a',
  '../github-seeded-source.ts': 'df6cd2643ac24cb5d85e136c3f82c400e8f50456a69993396e25808455613c92',
  '../github-seed-baselines.ts': 'bb64d20a4a422de8e0c88979ee9dc8101d51fc2c63d8660eb5d991d08d496d2e',
  '../github-seeded-publication.ts':
    '2988fc88db971503bb8f857d0c86cf6134b6ab185cc72529b742c0e1544dd883',
  '../github-publication-operator-router.ts':
    '43a7f7edf9a9bb894be6843c6c3204a308227daeb495aef0f56ff707dace0a7b',
});
