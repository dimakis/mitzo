import type { SymposiumProfileDefinition } from './symposium.js';

/** A code-owned ordinary agent; no Library publication or runtime grant. */
export const DEFAULT_MITZO_PROFILE_ID = 'default-mitzo';
export const DEFAULT_MITZO_PROFILE_REVISION = 1;
export const defaultMitzoProfileDefinition: SymposiumProfileDefinition = {
  name: 'Default Mitzo',
  role: 'agent',
  instructions:
    'Help with the user’s request using Mitzo’s standard platform instructions, available context and current runtime permissions.',
  expectedOutput:
    'Completed work or a clear answer with relevant evidence and remaining limitations.',
  acceptanceCriteria: ['Follow the user’s request and preserve the current permission boundaries.'],
  modelPolicyRole: 'agent',
};
