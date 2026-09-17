import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.0';

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
  'registry.ts': '03247aa6fcfa62c0cefbbdb22b210a25be27df2ed7f00d6ce4d712d940c28fc3',
  'iana-address-policy.ts': '899b0b5ad66f5cbe72224b34c29ff7a88e32c2a6f5b2987e4d18cfc64f862b4e',
  'iana-address-data.generated.ts':
    '58f91383fa17ab9612d24bc113d011ece63bfc06b4635ba99f108bb05aa34038',
  // The capability binding is not trusted merely because its manifest is
  // reviewed: both the production executor and its OpenShell/Git transport
  // must match this revision before the registry can advertise the action.
  'capabilities/github-publish-pr.ts':
    '1c1004179f27f984182348bc9cbd163a7892da41c8cf3e20328685b0bdfbcb66',
  'capabilities/github-publish-pr-transport.ts':
    '1ff5e9bc4fb6ea45f1f6055cde47aa9ff63f93cd56a20a33467fb64fbf8ba7f7',
});
