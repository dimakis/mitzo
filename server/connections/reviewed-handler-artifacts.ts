import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.0';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.5';

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
  'registry.ts': '3482b7cc71334c4daec6e230ad104cecf1ff5ff6c5d924d5d2becf5162393a93',
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
    'be6bb8805079b8eb5561cfe390147914e123e371c128e64a64359aeba90552ca',
  '../capability-conversation-binding.ts':
    '147a328d161f167aeeb31bf0017d5fea25cc3f22933392249a228d7bd61e89aa',
  '../connections-runtime.ts': '87326dcba90429b11fcf8e4a95243433a2c3e658b812aa99a8b22fbedae15be5',
  'capabilities/operation-store.ts':
    '1a235f11d5578880e6dfa7ecf5779e2a011e24430774fc17429d7d22359b93f2',
  'capabilities/service.ts': '848e0998848d68e80ec53731b248a286f77f761905082092821f3ec9047ba36a',
  '../github-seeded-source.ts': 'df6cd2643ac24cb5d85e136c3f82c400e8f50456a69993396e25808455613c92',
  '../github-seed-baselines.ts': 'bb64d20a4a422de8e0c88979ee9dc8101d51fc2c63d8660eb5d991d08d496d2e',
  '../github-seeded-publication.ts':
    '2988fc88db971503bb8f857d0c86cf6134b6ab185cc72529b742c0e1544dd883',
  '../github-publication-operator-router.ts':
    '259940309a05e749d6968a8a39491e4f8345ea362eaafee50dd8d096f4309950',
});
