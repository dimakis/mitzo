import type { CapabilityTemplate } from './types.js';
/** Exact shared reviewed manifest, independent of ordinary provider registries. */
export const githubPublicationTemplate: CapabilityTemplate = {
  id: 'github.publish-pr',
  version: 1,
  label: 'Publish pull request',
  description:
    'Publish already-committed work to an approved feature branch after explicit approval.',
  connectionTemplates: [{ id: 'github-readonly', version: 1 }],
  inputSchema: {
    type: 'object',
    properties: {
      connectionId: { type: 'string', minLength: 1, maxLength: 128 },
      repositoryPath: { type: 'string', minLength: 1, maxLength: 256 },
      baseBranch: { type: 'string', minLength: 1, maxLength: 128 },
      title: { type: 'string', minLength: 1, maxLength: 128 },
      body: { type: 'string', maxLength: 512 },
      draft: { type: 'boolean' },
    },
    required: ['connectionId', 'repositoryPath', 'baseBranch', 'title', 'body', 'draft'],
    additionalProperties: false,
  },
  executor: 'github-publish-pr-v1',
  approval: 'always',
  idempotency: 'required',
};
