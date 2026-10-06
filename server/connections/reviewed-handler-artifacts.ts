import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.0';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.3';

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
  'registry.ts': '5ee5f27bf975d30b82b59418205fad062b77d31bed7fb7097f4e06078e3feef0',
  'iana-address-policy.ts': '899b0b5ad66f5cbe72224b34c29ff7a88e32c2a6f5b2987e4d18cfc64f862b4e',
  'iana-address-data.generated.ts':
    '58f91383fa17ab9612d24bc113d011ece63bfc06b4635ba99f108bb05aa34038',
  // The capability binding is not trusted merely because its manifest is
  // reviewed: both the production executor and its OpenShell/Git transport
  // must match this revision before the registry can advertise the action.
  'capabilities/github-publish-pr.ts':
    'a857440278dc54d94f67c23769c632c81fddac8cee383f1e6ea1908fa6d3fbcb',
  'capabilities/github-publish-pr-transport.ts':
    'bf4bf70d935aab2c5d8c9561ad484bec23c10cf47f4921b099ed2a6a6933d262',
  '../github-host-source.ts': 'bf560c952f6fdb9f174c667a5dc91c237a1b2e5e8542d3692d3e8fb11df0e6d6',
  '../github-publishing-tool.ts':
    '2926e92a76bd2fbbda72b824c1821db914ca3af6df0553fb5318fb93e35041db',
  '../capability-conversation-binding.ts':
    '147a328d161f167aeeb31bf0017d5fea25cc3f22933392249a228d7bd61e89aa',
  '../connections-runtime.ts': 'bc760b9e8e033789325c5f5ca8c19c31679ba286ed300e6eaed04d22be439b24',
  'capabilities/service.ts': '450b3ffe67c376aeab43edc3aa3bda5a625a807470dce0d4b6e7aad1136f054e',
});
