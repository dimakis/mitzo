import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { SymposiumConfigSchema } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { createTelosConversationSource } from '../telos-conversation-source.js';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-source-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const events = new EventStore(join(root, 'events.db'));
  cleanups.push(() => events.close());
  events.upsertSession({
    sessionId: 'origin',
    conversationSource: 'mitzo',
    summary: 'Original discussion',
  });
  const dbPath = join(root, 'telos.db');
  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY); INSERT INTO items VALUES('item'); CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT)",
  );
  db.close();
  const artifacts = new TelosArtifactStore(dbPath);
  cleanups.push(() => artifacts.close());
  let allowed = true;
  const source = createTelosConversationSource({ events, artifacts, authorize: () => allowed });
  const append = (type: string, payload: Record<string, unknown>) =>
    events.append('origin', type, payload);
  append('user_message', {
    messageId: 'question',
    text: 'Please plan the feature.',
    privateExtension: 'DO NOT COPY',
  });
  append('message_start', { messageId: 'answer' });
  append('block_start', { messageId: 'answer', blockId: 'thought', blockType: 'thinking' });
  append('block_delta', { messageId: 'answer', blockId: 'thought', delta: 'PRIVATE REASONING' });
  append('block_start', { messageId: 'answer', blockId: 'tool', blockType: 'tool_use' });
  append('tool_result', { messageId: 'answer', blockId: 'tool', content: 'PRIVATE TOOL OUTPUT' });
  append('block_start', { messageId: 'answer', blockId: 'visible', blockType: 'text' });
  append('block_delta', {
    messageId: 'answer',
    blockId: 'visible',
    delta: 'Approved public plan.',
  });
  append('block_end', { messageId: 'answer', blockId: 'visible', blockType: 'text' });
  const boundary = append('message_end', { messageId: 'answer' });
  const selection = {
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: 'origin',
    boundary: { sequence: boundary, messageId: 'answer' },
    mode: 'selected' as const,
    messageIds: ['question', 'answer'],
    artifacts: [],
    purpose: 'Save outcome',
    joiningBrief: '',
  };
  return {
    events,
    source,
    artifacts,
    append,
    selection,
    revoke: () => {
      allowed = false;
    },
  };
}

describe('Telos adapter for the existing authorized context compiler', () => {
  it('refuses captured saved source snapshots while allowing unrelated text at the same boundary', async () => {
    const f = fixture();
    const content = 'The exact saved morning briefing.';
    const sequence = f.append('user_message', {
      messageId: 'saved-briefing',
      text: 'Discuss this saved briefing.',
      sourceSnapshots: [
        {
          kind: 'briefing',
          date: '2026-10-16',
          revision: createHash('sha256').update(content).digest('hex'),
          content,
        },
      ],
    });
    const selection = { ...f.selection, boundary: { sequence, messageId: 'saved-briefing' } };
    await expect(
      f.source.openConversation({ ...selection, mode: 'conversation_so_far', messageIds: [] }),
    ).rejects.toThrow(/source snapshots.*retained materials/);
    await expect(
      f.source.openConversation({ ...selection, messageIds: ['saved-briefing'] }),
    ).rejects.toThrow(/source snapshots.*retained materials/);
    const narrow = await f.source.openConversation({ ...selection, messageIds: ['answer'] });
    expect((await narrow.readSelected(['answer'])).map((m) => m.messageId)).toEqual(['answer']);
  });

  it('refuses inline images in captured content rather than claiming a complete text-only exchange', async () => {
    const f = fixture();
    const sequence = f.append('user_message', {
      messageId: 'inline-mock',
      text: 'Use this approved mock.',
      images: ['data:image/png;base64,fixture-image'],
    });
    const selection = { ...f.selection, boundary: { sequence, messageId: 'inline-mock' } };
    await expect(
      f.source.openConversation({ ...selection, mode: 'conversation_so_far', messageIds: [] }),
    ).rejects.toThrow(/images.*retained materials/);
    await expect(
      f.source.openConversation({ ...selection, messageIds: ['inline-mock'] }),
    ).rejects.toThrow(/images.*retained materials/);
    const narrow = await f.source.openConversation({ ...selection, messageIds: ['answer'] });
    expect((await narrow.readSelected(['answer'])).map((m) => m.messageId)).toEqual(['answer']);
  });

  it('retains immutable native seat attribution through the actual event owner', async () => {
    const f = fixture();
    const seats = ['builder', 'reviewer'].map((id, i) => ({
      id,
      name: id,
      role: i === 0 ? 'primary' : 'reviewer',
      model: 'offline-fixture',
      systemPrompt: 'Plan.',
      color: '#8040cc',
      accountBinding: {
        accountId: id,
        accountLabel: id,
        provider: 'openai-codex',
        model: 'offline-fixture',
        profileRevision: 'account-r1',
      },
      profileBinding: { profileId: id, profileRevision: 'profile-r1' },
      contextGrant: {
        grantId: 'context-' + id,
        revision: 1,
        classification: 'work',
        sourceRefs: [],
      },
      authorityGrant: {
        grantId: 'authority-' + id,
        revision: 1,
        filesystem: 'read',
        tools: 'read',
        network: 'restricted',
      },
      isolationRequest: { trustDomainId: 'shared', revision: 1, placement: 'reuse-compatible' },
    }));
    const config = SymposiumConfigSchema.parse({
      version: 1,
      revision: 1,
      state: 'active',
      seats,
      turnRules: { mode: 'directed', maxTurns: 4 },
      interceptMode: 'manual',
    });
    f.events.upsertSession({ sessionId: 'origin', accountBinding: config.seats[0].accountBinding });
    f.events.setSymposiumConfig('origin', config);
    const provenance = {
      version: 2,
      seatId: 'builder',
      seatLabel: 'builder',
      seatRole: 'primary',
      membershipGeneration: 1,
      capturedAt: 1,
      configRevision: 1,
      accountProfileRevision: 'account-r1',
      seatProfileRevision: 'profile-r1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'shared',
      isolationDomainRevision: 1,
      accountBinding: seats[0].accountBinding,
      profileBinding: seats[0].profileBinding,
      reasoningEffort: null,
      contextGrant: { grantId: 'context-builder', revision: 1 },
      authorityGrant: { grantId: 'authority-builder', revision: 1 },
    };
    const append = (type: string, payload: Record<string, unknown>) =>
      f.events.appendSymposium('origin', type, { messageId: 'native', ...payload }, provenance);
    append('message_start', {});
    append('block_start', { blockId: 'plan', blockType: 'text' });
    append('block_delta', { blockId: 'plan', delta: 'Native public plan.' });
    append('block_end', { blockId: 'plan', blockType: 'text' });
    const sequence = append('message_end', {});
    const opened = await f.source.openConversation({
      ...f.selection,
      messageIds: ['native'],
      boundary: { sequence, messageId: 'native' },
    });
    expect((await opened.readSelected(['native']))[0].blocks[0].content).toBe(
      'Native public plan.',
    );
    expect(opened.attributions.native).toMatchObject({ seatId: 'builder', provenance });
  });

  it('pins the source capability implementation in the reviewed runtime manifest', () => {
    const manifest: Record<string, string> = reviewedHandlerSourceArtifacts;
    expect(manifest['../telos-conversation-source.ts']).toBe(
      reviewedHandlerSourceFingerprint(
        readFileSync(new URL('../telos-conversation-source.ts', import.meta.url), 'utf8'),
      ),
    );
  });
  it('reads only completed public text at the selected durable boundary and ignores later messages', async () => {
    const f = fixture();
    const opened = await f.source.openConversation(f.selection);
    const selected = await opened.readSelected(['question', 'answer']);
    expect(
      selected.map((message) => message.blocks.map((block) => block.content).join('')),
    ).toEqual(['Please plan the feature.', 'Approved public plan.']);
    expect(selected[1].blocks.map((block) => block.blockId)).toEqual(['visible']);
    expect(JSON.stringify(selected)).not.toMatch(/PRIVATE|DO NOT COPY/);
    f.append('user_message', {
      messageId: 'later',
      text: 'A later change must not enter the approved source.',
    });
    await expect(opened.assertCurrent()).resolves.toBeUndefined();
    expect(await opened.readSelected(['question', 'answer'])).toEqual(selected);
    await expect(opened.readSelected(['later'])).rejects.toThrow();
    expect(f.events.getSession('origin')?.telosTaskId).toBeNull();
  });

  it('provides a complete bounded page witness and refuses invented boundaries and incomplete selections', async () => {
    const f = fixture();
    const opened = await f.source.openConversation({
      ...f.selection,
      mode: 'conversation_so_far',
      messageIds: [],
    });
    const page = await opened.readPage(0, 50);
    expect(page).toMatchObject({
      afterSequence: 0,
      throughSequence: f.selection.boundary.sequence,
      hasMore: false,
    });
    const witness = await opened.readPrefixWitness();
    expect(witness).toEqual({
      messageCount: 2,
      messagesSha256: createHash('sha256').update(JSON.stringify(page.messages)).digest('hex'),
      artifactPins: [],
    });
    await expect(
      f.source.openConversation({
        ...f.selection,
        boundary: { sequence: f.selection.boundary.sequence + 1, messageId: 'answer' },
      }),
    ).rejects.toThrow();
    await expect(
      f.source.openConversation({
        ...f.selection,
        boundary: { ...f.selection.boundary, messageId: 'wrong' },
      }),
    ).rejects.toThrow();
    f.append('message_start', { messageId: 'unfinished' });
    f.append('block_start', { messageId: 'unfinished', blockId: 'partial', blockType: 'text' });
    const incomplete = f.append('block_delta', {
      messageId: 'unfinished',
      blockId: 'partial',
      delta: 'Not completed',
    });
    await expect(
      f.source.openConversation({
        ...f.selection,
        boundary: { sequence: incomplete, messageId: 'unfinished' },
      }),
    ).rejects.toThrow();
    const selected = await f.source.openConversation(f.selection);
    await expect(selected.readSelected(['unknown'])).rejects.toThrow();
    await expect(selected.readSelected(['answer', 'answer'])).rejects.toThrow();
  });

  it('rechecks source authority and deletion instead of treating a retained session ID as access', async () => {
    const f = fixture();
    const opened = await f.source.openConversation(f.selection);
    f.revoke();
    await expect(opened.assertCurrent()).rejects.toThrow();
    await expect(opened.readSelected(['answer'])).rejects.toThrow();
    await expect(f.source.openConversation(f.selection)).rejects.toThrow();
    const other = fixture();
    const original = await other.source.openConversation(other.selection);
    other.events.hideSession('origin');
    await expect(original.assertCurrent()).rejects.toThrow();
    await expect(other.source.openConversation(other.selection)).rejects.toThrow();
  });

  it('reads exact retained artifact bytes and hashes, even after a later revision is saved', async () => {
    const f = fixture();
    const save = (text: string) =>
      f.artifacts.save({
        itemId: 'item',
        filename: 'plan.md',
        title: 'Plan',
        bytes: Buffer.from(text),
        sessionId: 'origin',
      });
    const r1 = save('Approved first revision');
    save('A later draft');
    const pin = { artifactId: r1.id, revision: r1.revision, sha256: r1.sha256 };
    await expect(f.source.authorizeArtifact(pin)).resolves.toBeUndefined();
    expect(await f.source.readArtifact(pin)).toMatchObject({
      ...pin,
      sourceConversationId: 'origin',
      bytes: Buffer.from('Approved first revision'),
    });
    await expect(f.source.readArtifact({ ...pin, sha256: 'f'.repeat(64) })).rejects.toThrow();
    f.revoke();
    await expect(f.source.authorizeArtifact(pin)).rejects.toThrow();
  });
  it('enumerates exact public artifact links in the complete-prefix witness and refuses a mutable latest link', async () => {
    const f = fixture();
    const artifact = f.artifacts.save({
      itemId: 'item',
      filename: 'mock.html',
      title: 'Mock',
      bytes: Buffer.from('approved bytes'),
      sessionId: 'origin',
    });
    const sequence = f.append('user_message', {
      messageId: 'material',
      text: '[Approved mock](' + artifact.url + ')',
    });
    const selection = {
      ...f.selection,
      mode: 'conversation_so_far' as const,
      messageIds: [],
      boundary: { sequence, messageId: 'material' },
    };
    const opened = await f.source.openConversation(selection);
    const pin = { artifactId: artifact.id, revision: artifact.revision, sha256: artifact.sha256 };
    expect((await opened.readPage(0, 50)).artifacts).toEqual([pin]);
    expect((await opened.readPrefixWitness()).artifactPins).toEqual([pin]);
    const latest = f.append('user_message', {
      messageId: 'mutable',
      text: '[Latest](/api/telos/artifacts/' + artifact.id + ')',
    });
    await expect(
      f.source.openConversation({
        ...selection,
        boundary: { sequence: latest, messageId: 'mutable' },
      }),
    ).rejects.toThrow();
  });

  it('pages a complete prefix without dropping middle messages and rejects ambiguous original identities', async () => {
    const f = fixture();
    let sequence = f.selection.boundary.sequence;
    for (let i = 0; i < 60; i++)
      sequence = f.append('user_message', { messageId: 'turn-' + i, text: 'Retained turn ' + i });
    const opened = await f.source.openConversation({
      ...f.selection,
      mode: 'conversation_so_far',
      messageIds: [],
      boundary: { sequence, messageId: 'turn-59' },
    });
    const first = await opened.readPage(0, 50);
    const last = await opened.readPage(first.throughSequence, 50);
    expect(first.hasMore).toBe(true);
    expect(last.hasMore).toBe(false);
    const messages = [...first.messages, ...last.messages];
    expect(messages).toHaveLength(62);
    expect((await opened.readPrefixWitness()).messagesSha256).toBe(
      createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
    );
    const duplicate = f.append('user_message', {
      messageId: 'question',
      text: 'Another message under the same source ID',
    });
    await expect(
      f.source.openConversation({
        ...f.selection,
        boundary: { sequence: duplicate, messageId: 'question' },
      }),
    ).rejects.toThrow();
  });
});
