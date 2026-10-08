import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.0';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.6';

/** Runtime admission changes without changing existing provider policy semantics. */
export const reviewedConnectionsRuntimeImplementationRevision = 'v1.0.6';

export function reviewedHandlerSourceFingerprint(source: string) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Generated during an intentional reviewed handler revision. These hash the
 * complete source modules containing compiler/probe/executor semantics, not
 * just fixtures. The build check verifies them on every server build.
 */
export const reviewedHandlerSourceArtifacts = Object.freeze({
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
  '../openai-key-management.ts': '536bffc8e2f8f8a73326ffe753ffd60b794b3f45072bb74b82d6ab7226946ead',
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
  // Admission shares compiled connection authority with gateway provisioning.
  'runtime-profiles.ts': '3632545ca52fbfad7442de08c03d5f9808b50b5bfdef92f9cd72b8fa8ab5140b',
  '../connections-gateway.ts': '8cc83813dff18a0cafba0fad53f3c5de987c8af631f8439029590285501849a1',
  '../openshell-runtime-policy.ts':
    'efecd458bf61fecd8198ecd330e0227e2c600ab21d6d2890cd2bac254e22b75f',
  '../openshell-runtime.ts': '71e650b8114df6264ce0a5b81ae32a1907ee3562c177c9d0d59c1f4825849b0c',
  '../codex-chat-session.ts': '8c11ec22ceac62890318d28e20b97175c1aba5afd4ff89ba2c74e43a3baadd78',
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
