import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@mitzo/harness';
import { z } from 'zod';
import {
  ProfileProposalInputSchema,
  type SymposiumProfileProposalStore,
} from './symposium-profile-proposals.js';

export const SYMPOSIUM_PROPOSE_PROFILE_TOOL = 'SymposiumProposeProfile';
export const symposiumProposeProfileDefinition: ToolDefinition = {
  name: SYMPOSIUM_PROPOSE_PROFILE_TOOL,
  description:
    'Draft reusable portable agent guidance for this conversation. This only creates a review proposal; the user must edit and save it in Mitzo. Never include credentials, conversation transcripts, session files, machine paths, account bindings or runtime grants.',
  input_schema: z.toJSONSchema(ProfileProposalInputSchema),
};

/** A provider call can propose guidance, but has no capability to save a profile. */
export function proposeProfileFromTool(input: {
  store: Pick<SymposiumProfileProposalStore, 'propose'>;
  owner: string;
  sessionId: string;
  turnId: string;
  callId: string;
  arguments: unknown;
}) {
  const parsed = ProfileProposalInputSchema.parse(input.arguments);
  const idempotencyKey = createHash('sha256')
    .update(JSON.stringify([input.sessionId, input.turnId, input.callId]))
    .digest('hex');
  return input.store.propose(input.owner, input.sessionId, idempotencyKey, parsed);
}
