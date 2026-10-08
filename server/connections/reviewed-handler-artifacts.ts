import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.0';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.5';

/** Credential synchronization changes runtime wiring without changing existing provider policies. */
export const reviewedConnectionsRuntimeImplementationRevision = 'v1.0.1';

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
  'registry.ts': 'ef8e9b23dba7212f3a4c78582a717bc549c5f75af0e9ec38df48df4ffe702660',
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
  '../openai-key-management.ts': '2c82c64d797053fc2e23b290a61c53635cc3001a07c1abf5ab0f4330f28f12cc',
  '../openai-key-operation-store.ts':
    'b257f487cef1bb92e7368030c7d7e6a851a5bef5f73be220e2801457cb61d3e3',
  '../openai-key-gateway.ts': '2057d0a71afdcff06b9f4f915816ffbeced447a567e3280470a007fcd2313bc7',
  '../keychain-rotation-credentials.ts':
    'c2d94ede80f5950b45568dc41c5d10c20802d4504dbcd0b6657e8de04de72d4a',
  '../openai-key-controller.ts': '4be89d1cb3b75270d6e3d257b5d35f569e26c726e8c23c3fb697ea0cff71c6ee',
  '../connections-router.ts': 'f4df4aca83baf65d934e747692e5541ea4d117ff9295dc16e362f80b6e88b9d3',
  '../connections-service.ts': '8815bc174ab94bf0a9bef1778931402c5a223e4545eaf8ceabc12b491a63a409',
  '../connections-runtime.ts': '8bd5cb4c1772347cdd635ebab68d04b7d5cc70eaa6bd0159242dd7850ef15e8e',
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
