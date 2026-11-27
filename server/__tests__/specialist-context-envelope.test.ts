import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  buildSpecialistContextEnvelope,
  measureSpecialistContextEnvelope,
  assertSpecialistContextLimit,
  specialistContextSelection,
} from '../specialist-context-envelope.js';
import { snapshotMaterial } from '../collaboration-context-input.js';

const input = {
  requestId: randomUUID(),
  role: 'reviewer',
  assignment: 'Review this.',
  messageIds: [],
  artifacts: [],
};
function draft(assignment = input.assignment) {
  const selection = specialistContextSelection(
    { ...input, assignment },
    'lead',
    { sequence: 0, messageId: null },
    1,
  );
  return {
    requestId: selection.requestId,
    sourceConversationId: selection.sourceConversationId,
    boundary: selection.boundary,
    mode: selection.mode,
    purpose: selection.purpose,
    joiningBrief: selection.joiningBrief,
    messages: [],
    artifacts: [],
    summary: null,
    capacity: { status: 'unverified' as const, reason: 'Not a token estimate' },
  };
}
it.each([-1, 0, 1])('enforces the 32000-byte ceiling at offset %i without truncation', (delta) => {
  const review = { ...input, reviewOf: randomUUID() };
  const contributions = [
    {
      text: '',
      profileId: 'planner',
      messageId: 'answer',
      source: { conversationId: 'planner-chat' },
    },
  ];
  const empty = buildSpecialistContextEnvelope(draft(), review, contributions);
  contributions[0].text = 'x'.repeat(
    32000 - measureSpecialistContextEnvelope(empty, 32000).totalBytes + delta,
  );
  const envelope = buildSpecialistContextEnvelope(draft(), review, contributions);
  const report = measureSpecialistContextEnvelope(envelope, 32000);
  expect(report.totalBytes).toBe(32000 + delta);
  expect(Object.values(report.components).reduce((sum, bytes) => sum + bytes, 0)).toBe(
    report.totalBytes,
  );
  expect(envelope.text).toContain(contributions[0].text);
  if (delta > 0)
    expect(() => assertSpecialistContextLimit(envelope, 32000, true)).toThrow('approved');
  else expect(assertSpecialistContextLimit(envelope, 32000, true)).toEqual(report);
});
it('counts UTF-8 and JSON escapes and preserves attributed evidence and artifact pins', () => {
  const content = '界🙂\n"é"';
  const sha256 = createHash('sha256').update(content).digest('hex');
  const source = {
    ...draft(),
    messages: [
      {
        messageId: 'm',
        conversationId: 'lead',
        sequence: 1,
        author: 'operator' as const,
        blocks: [{ blockId: 'b', content, sha256 }],
        source: null,
      },
    ],
    artifacts: [
      {
        artifactId: 'a',
        revision: 2,
        sha256,
        sourceConversationId: 'lead',
        mediaType: 'text/plain',
        sizeBytes: Buffer.byteLength(content),
        contentBase64: Buffer.from(content).toString('base64'),
      },
    ],
  };
  const review = { ...input, assignment: content, reviewOf: randomUUID() };
  const contributions = [
    {
      text: content,
      role: 'planner',
      profileId: 'p',
      revision: 3,
      accountId: 'account',
      model: 'model',
      messageId: 'answer',
      source: { conversationId: 'p-chat' },
    },
  ];
  const envelope = buildSpecialistContextEnvelope(source, review, contributions);
  const report = measureSpecialistContextEnvelope(envelope, 32000);
  expect(report.totalBytes).toBe(
    Buffer.byteLength(
      JSON.stringify({ context: snapshotMaterial(source), text: envelope.text }),
      'utf8',
    ),
  );
  expect(report.components.assignment).toBe(
    Buffer.byteLength(JSON.stringify(content).slice(1, -1)),
  );
  expect(report.messages).toEqual([
    { messageId: 'm', bytes: Buffer.byteLength(JSON.stringify(source.messages[0])) },
  ]);
  expect(report.artifacts[0]).toMatchObject({
    artifactId: 'a',
    revision: 2,
    contentBytes: Buffer.byteLength(content),
  });
  expect(envelope.draft).toEqual(source);
  expect(envelope.text).toContain(JSON.stringify({ requestId: review.reviewOf, contributions }));
  contributions[0].text = 'changed';
  expect(envelope.text).not.toContain('changed');
});
it('removes only constructed assignment copies, never matching source evidence', () => {
  const source = draft();
  const envelope = buildSpecialistContextEnvelope(source, input);
  expect(source.joiningBrief).not.toContain(input.assignment);
  expect(source.purpose).not.toContain(input.assignment);
  expect(envelope.text).toBe(input.assignment);
});
