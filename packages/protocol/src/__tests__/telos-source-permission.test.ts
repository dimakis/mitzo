import { describe, expect, it } from 'vitest';
import * as protocol from '../telos-source.js';

describe('reviewed Telos permission contract', () => {
  it('accepts explicit whole-message choices and refuses proposal/actor overrides', () => {
    const input = {
      sessionId: 'origin',
      requestId: '00000000-0000-4000-8000-000000000001',
      proposalSha256: 'a'.repeat(64),
      selection: {
        mode: 'selected',
        boundary: { sequence: 3, messageId: 'message' },
        messageIds: ['message'],
        artifacts: [],
      },
    };
    expect(protocol.TelosSourcePermissionPreviewRequestSchema.parse(input)).toEqual(input);
    for (const override of [
      { actor: 'operator' },
      { outcome: {} },
      { sourceConversationId: 'other' },
    ])
      expect(() =>
        protocol.TelosSourcePermissionPreviewRequestSchema.parse({ ...input, ...override }),
      ).toThrow();
    expect(() =>
      protocol.TelosSourcePermissionPreviewRequestSchema.parse({
        ...input,
        selection: { ...input.selection, blockSelections: [] },
      }),
    ).toThrow();
  });
});
