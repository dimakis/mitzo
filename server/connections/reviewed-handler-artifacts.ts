import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.0';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.4';

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
    'a857440278dc54d94f67c23769c632c81fddac8cee383f1e6ea1908fa6d3fbcb',
  'capabilities/github-publish-pr-transport.ts':
    'b0020f8510d8ea386f026f7cec0a3f819c0c442e1f1ce6828c6cfc0d3b25252e',
  '../github-host-source.ts': '55fa3133686f4f9abdf1c529db529cbc82f085cbcc2aca6bfbb6e08a2319e5bc',
  '../github-publishing-tool.ts':
    '93b7218ec80c1c03feab986f97b1b829e9983236a7ed5df8b12f38bee06a3e49',
  '../capability-conversation-binding.ts':
    '147a328d161f167aeeb31bf0017d5fea25cc3f22933392249a228d7bd61e89aa',
  '../connections-runtime.ts': 'f82ae9ad305714295cf6055d5ebc77688138ce6913a642551ab33fdea1f32d37',
  'capabilities/operation-store.ts':
    '1a235f11d5578880e6dfa7ecf5779e2a011e24430774fc17429d7d22359b93f2',
  'capabilities/service.ts': '450b3ffe67c376aeab43edc3aa3bda5a625a807470dce0d4b6e7aad1136f054e',
});
