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
  'policy-compiler.ts': 'e48dc6987b64ff15ef2e3df7a5df9e26ee7c22269ffdc1f1f3e6b4b5f4eae29f',
  'registry.ts': '6a8bd521617d005dbd7aa1b7d271353e3d0ed2cefb699d59e9d7903ad170d273',
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
