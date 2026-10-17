import { expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  CollaborationForwardSelectionSchema as ProtocolSelection,
  collaborationForwardSelectionFingerprint,
} from '@mitzo/protocol';
import {
  CollaborationForwardSelectionSchema,
  collaborationForwardFingerprint,
} from '../collaboration-forwarding.js';

const selection = {
  requestId: '00000000-0000-4000-8000-000000000001',
  target: {
    collaborationId: '00000000-0000-4000-8000-000000000002',
    expectedMembershipRevision: 1,
    sessionIds: ['recipient'],
  },
  sourceConversationId: null,
  boundary: null,
  messages: [],
  artifacts: [
    { kind: 'retained_artifact', artifactId: 'saved', revision: 1, sha256: 'a'.repeat(64) },
  ],
};
it('uses the same selector owner for source preparation and durable storage', () => {
  expect(CollaborationForwardSelectionSchema).toBe(ProtocolSelection);
});
it('retains the same normalized fingerprint through both existing entry points', () => {
  const reordered = Object.fromEntries(Object.entries(selection).reverse());
  expect(collaborationForwardFingerprint(reordered)).toBe(
    collaborationForwardSelectionFingerprint(selection),
  );
});
it('refuses unsupported recipient keys at the same boundary before source work', () => {
  const unsupported = { ...selection, target: { ...selection.target, sessionIds: ['__proto__'] } };
  expect(() => CollaborationForwardSelectionSchema.parse(unsupported)).toThrow(ZodError);
});
