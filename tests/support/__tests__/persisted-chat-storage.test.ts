import { expect, it } from 'vitest';
import { persistedChatDraftText } from '../persisted-chat-storage';

const sessionId = 'worker:one';
const draftId = 'launch:one';
const target = 'mitzo-chat-draft-session:' + encodeURIComponent(sessionId);
const source = 'mitzo-chat-draft-assignment:' + encodeURIComponent(draftId);
const payload = 'mitzo-chat-draft:' + draftId;
function fixture() {
  const binding = JSON.stringify({ version: 1, sessionId, draftId });
  const values = new Map<string, string>([
    [target, binding],
    [source, binding],
    [
      payload,
      JSON.stringify({
        version: 1,
        id: draftId,
        text: 'Exact seed',
        images: [],
        contextBlocks: [],
        updatedAt: 1,
        settings: { selection: null, mode: 'agent', isolation: true, search: '', summary: null },
      }),
    ],
  ]);
  return { values, storage: { getItem: (key: string) => values.get(key) ?? null } };
}

it('observes the exact two-sided bound rich draft without needing a plain session key', () => {
  const { storage } = fixture();
  expect(persistedChatDraftText(storage, sessionId)).toBe('Exact seed');
});
it('preserves an independent plain draft, including an empty one, over an older rich binding', () => {
  const { storage, values } = fixture();
  values.set('mitzo-draft-' + sessionId, 'Independent draft');
  expect(persistedChatDraftText(storage, sessionId)).toBe('Independent draft');
  values.set('mitzo-draft-' + sessionId, '');
  expect(persistedChatDraftText(storage, sessionId)).toBe('');
});
it('never accepts the same text from a different session or an unbound payload', () => {
  const { storage, values } = fixture();
  expect(persistedChatDraftText(storage, 'other-worker')).toBeNull();
  values.delete(target);
  expect(persistedChatDraftText(storage, sessionId)).toBeNull();
});
it.each([
  'missing backlink',
  'wrong session',
  'wrong target session',
  'wrong draft',
  'extra binding field',
])('rejects %s even with matching payload text', (problem) => {
  const { storage, values } = fixture();
  if (problem === 'missing backlink') values.delete(source);
  if (problem === 'wrong session')
    values.set(source, JSON.stringify({ version: 1, sessionId: 'other', draftId }));
  if (problem === 'wrong target session')
    values.set(target, JSON.stringify({ version: 1, sessionId: 'other', draftId }));
  if (problem === 'wrong draft')
    values.set(source, JSON.stringify({ version: 1, sessionId, draftId: 'other' }));
  if (problem === 'extra binding field')
    values.set(target, JSON.stringify({ version: 1, sessionId, draftId, extra: true }));
  expect(persistedChatDraftText(storage, sessionId)).toBeNull();
});
it.each([
  '{invalid JSON',
  JSON.stringify({ version: 1, id: 'different-owner', text: 'Exact seed' }),
  JSON.stringify({ version: 2, id: draftId, text: 'Exact seed' }),
])('rejects an invalid rich owner record', (value) => {
  const { storage, values } = fixture();
  values.set(payload, value);
  expect(persistedChatDraftText(storage, sessionId)).toBeNull();
});
