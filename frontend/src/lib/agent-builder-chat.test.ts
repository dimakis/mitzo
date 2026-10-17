// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { newAgentDefinition } from './agent-library';
import { getChatDraft, saveChatDraft } from './chat-drafts';
import { openAgentBuilderChat, markAgentBuilderAssigned } from './agent-builder-chat';
import type { AgentLibraryEditor } from './agent-library-working-copy';
const editor = (): AgentLibraryEditor => ({
  profileId: 'bob',
  definition: {
    ...newAgentDefinition(),
    name: 'Working Bob',
    descriptor: ' The architect ',
    instructions: 'First\n  second ',
  },
  expectedVersion: 2,
  baseRevision: 3,
  publishedRevision: 3,
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
it('opens one ordinary draft with an exact unsaved snapshot and no account override', () => {
  const input = editor();
  const path = openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(draft.settings.launch).toBeUndefined();
  expect(draft.settings.selection).toBeNull();
  expect(draft.contextBlocks).toEqual([]);
  expect(draft.text).toBe('Help me refine this agent.');
  const search = new URLSearchParams(draft.settings.search);
  expect(search.get('agentProfile')).toBe('mitzo-profile-builder');
  expect(search.get('agentProfileKind')).toBe('builtin');
  const source = draft.settings.sourceSnapshots![0];
  expect(source.kind).toBe('agent-library');
  expect(JSON.parse(source.content)).toMatchObject({
    source: {
      kind: 'draft',
      profileId: 'bob',
      baseRevision: 3,
      draftVersion: null,
      expectedVersion: 2,
    },
    definition: input.definition,
  });
  expect(openAgentBuilderChat(input, true)).toBe(path);
  draft.text = 'My unfinished question';
  saveChatDraft(draft);
  expect(getChatDraft(draft.id)?.text).toBe('My unfinished question');
  expect(openAgentBuilderChat(input, true)).toBe(path);
});
it('pins published provenance and opens changed edits independently', () => {
  const input = editor();
  const path = openAgentBuilderChat(input, false, 'a'.repeat(64));
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(JSON.parse(draft.settings.sourceSnapshots![0].content).source).toEqual({
    kind: 'published',
    profileId: 'bob',
    revision: 3,
    contentHash: 'a'.repeat(64),
  });
  expect(
    openAgentBuilderChat(
      { ...input, definition: { ...input.definition, name: 'Newer Bob' } },
      true,
    ),
  ).not.toBe(path);
});
it('returns to the assigned real conversation without allocating a second draft', () => {
  const input = editor();
  const path = openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  markAgentBuilderAssigned(draft, 'assigned-session');
  expect(openAgentBuilderChat(input, true)).toBe('/chat/assigned-session');
});
it('reports storage failure before navigating', () => {
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw Error('full');
  };
  try {
    expect(() => openAgentBuilderChat(editor(), true)).toThrow(/save|retain/i);
  } finally {
    Storage.prototype.setItem = original;
  }
});
it('uses the durable admission owner to recover a cold assignment and fences a second command', async () => {
  const { agentBuilderCommandHandoff } = await import('./agent-builder-chat');
  const input = editor();
  const path = openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  const command = {
    sessionId: null,
    clientMsgId: 'original-command',
    sourceSnapshots: draft.settings.sourceSnapshots,
  };
  expect(agentBuilderCommandHandoff.prepare(command)).toBe(true);
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'duplicate-command' })).toBe(
    false,
  );
  expect(openAgentBuilderChat(input, true)).toBe(path);
  agentBuilderCommandHandoff.assign('original-command', 'recovered-session', {
    kind: 'agent-library',
    revision: draft.settings.sourceSnapshots![0].revision,
  });
  expect(openAgentBuilderChat(input, true)).toBe('/chat/recovered-session');
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'duplicate-command' })).toBe(
    false,
  );
});
it('retains a failed assignment for exact retry and releases only a definitive rejection', async () => {
  const { agentBuilderCommandHandoff } = await import('./agent-builder-chat');
  const input = editor();
  const path = openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  const command = {
    clientMsgId: 'native-command',
    payload: { sourceSnapshots: draft.settings.sourceSnapshots },
  };
  expect(agentBuilderCommandHandoff.prepare(command)).toBe(true);
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw Error('full');
  };
  try {
    expect(() => agentBuilderCommandHandoff.assign('native-command', 'session')).toThrow();
  } finally {
    Storage.prototype.setItem = original;
  }
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'new-command' })).toBe(
    false,
  );
  agentBuilderCommandHandoff.reject('native-command');
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'new-command' })).toBe(true);
});
it('keeps reviewed source and its draft identity when the user clears the opening question', () => {
  const input = editor();
  const path = openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  draft.text = '';
  expect(saveChatDraft(draft)).toBe(true);
  expect(getChatDraft(draft.id)?.settings.sourceSnapshots).toEqual(draft.settings.sourceSnapshots);
  expect(openAgentBuilderChat(input, true)).toBe(path);
});
it('hands unfinished editor fields to Builder without normalizing them or demanding publication validity', () => {
  const input = editor();
  input.definition.role = 'unfinished role ';
  input.definition.modelPolicyRole = ' ';
  input.definition.descriptor = ' '.repeat(90);
  input.definition.recipe = {
    version: 1,
    context: { include: [], sources: [] },
    skillRefs: [' ', ''],
    toolDefaults: { mode: 'read-only', preferredTools: [' ', ''] },
    compatibleProviders: [],
    reviewerTemplate: 'general',
  };
  const path = openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(JSON.parse(draft.settings.sourceSnapshots![0].content).definition).toEqual(
    input.definition,
  );
});
it('keeps explicitly reviewed context pinned with the draft across Builder reentry', () => {
  const input = editor();
  const context = '# Reviewed context\nExact  spaces and lines.\n';
  const path = openAgentBuilderChat(input, true, undefined, context);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(JSON.parse(draft.settings.sourceSnapshots![0].content).reviewedContext).toBe(context);
  expect(openAgentBuilderChat(input, true, undefined, context)).toBe(path);
});
