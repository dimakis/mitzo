import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CollaborationContractError } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { repositoryChatContext } from '../repository-chat-startup.js';
import { specialistDiagnostic } from '../specialist-consultation-diagnostics.js';

const TYPED = 'yo lets do a symposium test';
// Old repository startups stored the provider envelope, not the typed command.
const ENVELOPE =
  repositoryChatContext({
    id: 'workspace',
    repository: 'local/primary',
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
    featureBranch: 'task',
  }) + TYPED;

let store: EventStore;
beforeEach(() => {
  store = new EventStore(':memory:');
});
afterEach(() => store.close());

const db = () => (store as unknown as { db: Database.Database }).db;

function admitOrdinary(sessionId: string, commandId: string, text: string) {
  store.insertSendCommand(commandId, sessionId, { text });
  db()
    .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
    .run('{"state":"consumed"}', commandId);
}

function reply(sessionId: string, messageId: string, text = 'Done') {
  store.append(sessionId, 'message_start', { messageId });
  store.append(sessionId, 'block_start', { messageId, blockId: 'b', blockType: 'text' });
  store.append(sessionId, 'block_delta', { messageId, blockId: 'b', delta: text });
  store.append(sessionId, 'block_end', { messageId, blockId: 'b' });
  store.append(sessionId, 'message_end', { messageId });
}

function refusal(work: () => unknown) {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw Error('Expected a refusal');
}

it('repairs a legacy repository envelope from the session’s own first ordinary receipt', () => {
  store.upsertSession({ sessionId: 'repo', conversationSource: 'mitzo', initialPrompt: ENVELOPE });
  admitOrdinary('repo', 'cmd-1', TYPED);
  store.append('repo', 'user_message', { messageId: 'cmd-1', text: TYPED });
  reply('repo', 'answer');

  expect(store.getInitialCommand('repo')).toEqual({ messageId: 'cmd-1', text: TYPED });
  const transcript = store.getDurableSessionTranscript('repo');
  expect(transcript.messages.map((message) => message.messageId)).toEqual(['cmd-1', 'answer']);
  expect(JSON.stringify(transcript)).not.toContain('Mitzo repository workspace');
});

it('keeps refusing an envelope that no matching receipt and first message can identify', () => {
  store.upsertSession({ sessionId: 'repo', conversationSource: 'mitzo', initialPrompt: ENVELOPE });
  // The receipt names a different text than the first visible message.
  admitOrdinary('repo', 'cmd-1', 'something else');
  store.append('repo', 'user_message', { messageId: 'cmd-1', text: TYPED });
  reply('repo', 'answer');

  expect(store.getInitialCommand('repo')).toEqual({ messageId: null, text: ENVELOPE });
  const error = refusal(() => store.getDurableSessionTranscript('repo'));
  expect(error).toBeInstanceOf(CollaborationContractError);
  expect(error).toMatchObject({
    code: 'source_initial_command_unverified',
    message: 'snapshot_changed',
  });
  expect(specialistDiagnostic(error)).toMatchObject({
    code: 'source_initial_command_unverified',
    message: expect.stringContaining('first command'),
  });
});

it('identifies the first command by its recorded identity, not by text equality', () => {
  store.upsertSession({
    sessionId: 'new',
    conversationSource: 'mitzo',
    initialPrompt: TYPED,
    initialMessageId: 'first',
  });
  store.append('new', 'user_message', { messageId: 'first', text: TYPED });
  reply('new', 'one');
  // The same words again are a separate, later command.
  store.append('new', 'user_message', { messageId: 'again', text: TYPED });
  reply('new', 'two');

  expect(store.getSession('new')?.initialMessageId).toBe('first');
  expect(store.getInitialCommand('new')).toEqual({ messageId: 'first', text: TYPED });
  expect(
    store.getDurableSessionTranscript('new').messages.map((message) => message.messageId),
  ).toEqual(['first', 'one', 'again', 'two']);
});

it('refuses a recorded identity that is not the first visible message', () => {
  store.upsertSession({
    sessionId: 'moved',
    conversationSource: 'mitzo',
    initialPrompt: TYPED,
    initialMessageId: 'first',
  });
  store.append('moved', 'user_message', { messageId: 'other', text: 'Earlier' });
  reply('moved', 'one');
  store.append('moved', 'user_message', { messageId: 'first', text: TYPED });
  reply('moved', 'two');

  expect(refusal(() => store.getDurableSessionTranscript('moved'))).toMatchObject({
    code: 'source_initial_command_unverified',
  });
});

it('treats a later change of the first-command identity as a changed source', () => {
  store.upsertSession({
    sessionId: 'pinned',
    conversationSource: 'mitzo',
    initialPrompt: TYPED,
    initialMessageId: 'first',
  });
  store.append('pinned', 'user_message', { messageId: 'first', text: TYPED });
  reply('pinned', 'one');
  const source = store.openCollaborationVisibleSource('pinned', {
    sequence: store.getSessionEvents('pinned').at(-1)!.seq,
    messageId: 'one',
  });
  source.assertCurrent();
  store.upsertSession({ sessionId: 'pinned', initialMessageId: 'replaced' });
  expect(() => source.assertCurrent()).toThrow('snapshot_changed');
});

it('reports a missing consultation request as not started under that request', () => {
  expect(specialistDiagnostic(Error('Consultation request not found'))).toMatchObject({
    code: 'consultation_not_found',
    message: expect.stringContaining('none started'),
  });
});
