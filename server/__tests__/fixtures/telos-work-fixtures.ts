import {
  TelosWorkConversationSchema,
  type TelosWorkItem,
  type TelosWorkSessionLink,
  type TelosWorkAssignment,
  type TelosWorkSourceSnapshot,
  type TelosWorkConversation,
  type TelosWorkAttempt,
  type TelosWorkControlReceipt,
} from '@mitzo/protocol';

/** Offline scenario data only. No real people, accounts, model calls, allocations
 * or product state. Sample identities are deliberately prefixed fixture-.
 * Shared by server tests and the frontend test-utils facade. Each invocation
 * builds independent objects. Keep this helper inside the server test project.
 */
export interface TelosWorkFixture {
  items: TelosWorkItem[];
  links: TelosWorkSessionLink[];
  assignments: TelosWorkAssignment[];
  snapshots: TelosWorkSourceSnapshot[];
  conversations: TelosWorkConversation[];
  attempts: TelosWorkAttempt[];
  controls: TelosWorkControlReceipt[];
  initialChatSelection: string | null;
  expectedUniqueChatCount: number;
}

const ordinary = (conversationId: string) => ({ namespace: 'mitzo' as const, conversationId });
const externalSource = () => ({
  namespace: 'external_codex' as const,
  conversationId: 'fixture-external-discussion',
  url: 'codex://threads/fixture-external-discussion',
});
const at = '2026-10-16T10:00:00Z'; // Known illustrative time, never a legacy default.

function item(
  itemId: string,
  summary: string,
  kind: TelosWorkItem['kind'],
  parentId: string | null = null,
): TelosWorkItem {
  return {
    version: 1,
    itemId,
    summary,
    kind,
    parentId,
    intent: `Agreed outcome for ${summary}.`,
    rationale: `Why ${summary} matters.`,
    acceptanceCriteria: ['Return attributable evidence for the agreed outcome.'],
    profile: 'manual',
    status: 'active',
    starred: false,
    categories: ['Personal projects'],
    createdAt: at,
    updatedAt: at,
    contextHints: {
      repos: [],
      paths: [],
      issues: [],
      docIds: [],
      people: [],
      jiraKeys: [],
      keywords: [],
      taskHint: 'Review the agreed brief.',
      sessionIds: [],
    },
    sources: [],
    links: [],
    legacyFields: {},
  };
}

function scenario(items: TelosWorkItem[]): TelosWorkFixture {
  return {
    items,
    links: [],
    assignments: [],
    snapshots: [],
    conversations: [],
    attempts: [],
    controls: [],
    initialChatSelection: null,
    expectedUniqueChatCount: 0,
  };
}

function origin(itemId: string): TelosWorkSessionLink {
  return {
    version: 1,
    linkId: `${itemId}-origin-link`,
    itemId,
    role: 'origin',
    conversation: externalSource(),
    linkedAt: at,
    linkedBy: 'fixture-operator',
    availability: 'available',
    attemptId: null,
  };
}

function link(
  itemId: string,
  conversationId: string,
  role: 'lead' | 'advisor' | 'worker' | 'reviewer',
): TelosWorkSessionLink {
  return {
    version: 1,
    linkId: `${conversationId}-link`,
    itemId,
    role,
    conversation: ordinary(conversationId),
    linkedAt: at,
    linkedBy: 'fixture-operator',
    availability: 'available',
    attemptId: null,
  };
}

function assign(
  itemId: string,
  conversationId: string,
  role: 'lead' | 'worker',
): TelosWorkAssignment {
  return {
    itemId,
    conversation: ordinary(conversationId),
    role,
    revision: 1,
    assignedAt: at,
    assignedBy: 'fixture-operator',
  };
}

function conversation(name: string): TelosWorkConversation {
  return TelosWorkConversationSchema.parse({
    conversation: ordinary(`fixture-conversation-${name}`),
    binding: {
      version: 2,
      account: {
        accountId: `fixture-account-${name}`,
        provider: 'openai-codex',
        profileRevision: 'fixture-account-r1',
      },
      harness: { implementation: 'codex' },
      execution: {
        location: 'openshell',
        targetId: `fixture-target-${name}`,
        targetRevision: 'fixture-target-r1',
      },
    },
    selection: {
      version: 1,
      agent: { profileId: `fixture-agent-${name}`, revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 1 },
      model: 'fixture-luna',
      thinking: name === 'review' ? 'standard' : 'high',
    },
    workspaceId: `fixture-workspace-${name}`,
    providerContinuationId: `fixture-provider-thread-${name}`,
    clientId: `fixture-client-${name}`,
    draft: `Independent draft for ${name}`,
    historyMessageIds: [`fixture-message-${name}`],
  });
}

function snapshot(itemId: string): TelosWorkSourceSnapshot {
  return {
    version: 1,
    snapshotId: `${itemId}-snapshot`,
    itemId,
    source: externalSource(),
    selection: {
      kind: 'selected',
      messageIds: ['fixture-source-message-12', 'fixture-source-message-18'],
      blockIds: ['fixture-source-block-18'],
      throughSequence: 18,
    },
    adoptedBrief: { revision: 'fixture-brief-r3', sha256: 'a'.repeat(64) },
    artifacts: [{ artifactId: 'b'.repeat(32), revision: 4, sha256: 'c'.repeat(64) }],
    author: 'Fixture planning partner',
    sourceCreatedAt: '2026-10-15T15:40:00Z',
    adoptedAt: at,
  };
}

export function createTelosWorkFixtures() {
  const homeStudio = scenario([
    item('fixture-studio', 'Home studio setup', 'outcome'),
    item('fixture-studio-slice', 'Plan the recording setup', 'work_item', 'fixture-studio'),
  ]);
  homeStudio.links = homeStudio.items.map((i) => origin(i.itemId));
  homeStudio.snapshots = homeStudio.items.map((i) => snapshot(i.itemId));
  homeStudio.expectedUniqueChatCount = 1;

  const leadWithUnstartedSlice = structuredClone(homeStudio);
  const lead = conversation('lead');
  leadWithUnstartedSlice.conversations.push(lead);
  leadWithUnstartedSlice.links.push(
    link('fixture-studio', lead.conversation.conversationId, 'lead'),
  );
  leadWithUnstartedSlice.assignments.push(
    assign('fixture-studio', lead.conversation.conversationId, 'lead'),
  );
  leadWithUnstartedSlice.expectedUniqueChatCount = 2;

  const multipleChats = scenario([item('fixture-controls', 'Contributor controls', 'work_item')]);
  multipleChats.links.push(origin('fixture-controls'));
  for (const [name, role] of [
    ['previous', 'worker'],
    ['current', 'worker'],
    ['review', 'reviewer'],
    ['advisor', 'advisor'],
  ] as const) {
    const chat = conversation(name);
    multipleChats.conversations.push(chat);
    multipleChats.links.push(link('fixture-controls', chat.conversation.conversationId, role));
  }
  multipleChats.assignments.push(
    assign('fixture-controls', 'fixture-conversation-current', 'worker'),
  );
  multipleChats.snapshots.push(snapshot('fixture-controls'));
  multipleChats.expectedUniqueChatCount = 5;

  const coordinated = scenario([
    item('fixture-coordinator', 'Mitzo coordinated delivery', 'coordinator'),
    ...[
      'Symposium',
      'Agent Library',
      'Tool Library',
      'Runtime routes',
      'Work & artifacts',
      'Chat performance',
    ].map((name, index) =>
      item(`fixture-outcome-${index + 1}`, name, 'outcome', 'fixture-coordinator'),
    ),
    {
      ...item('fixture-job', 'Quarterly connections', 'outcome'),
      categories: ['Job', 'Management'],
    },
  ]);
  for (const [index, stage] of ['requested', 'acknowledged', 'applied', 'released'].entries()) {
    coordinated.controls.push({
      version: 1,
      controlId: 'fixture-publication-hold',
      coordinatorItemId: 'fixture-coordinator',
      coordinatorConversationId: 'fixture-conversation-coordinator',
      targetOutcomeId: 'fixture-outcome-2',
      targetLeadConversationId: 'fixture-conversation-lead-2',
      scope: 'publication',
      stage: stage as TelosWorkControlReceipt['stage'],
      evidenceRef: `fixture-control-evidence-${index}`,
      workerEvidenceRefs: stage === 'applied' ? ['fixture-worker-application-receipt'] : [],
      publicationRevalidation: stage === 'released' ? 'required' : 'not_applicable',
    });
  }
  const nestedCoordinator = scenario([
    item('fixture-outer', 'Portfolio coordination', 'coordinator'),
    item('fixture-inner', 'Mitzo coordination', 'coordinator', 'fixture-outer'),
    item('fixture-nested-outcome', 'Nested outcome', 'outcome', 'fixture-inner'),
  ]);

  const legacy = item('fixture-legacy-item', 'Original summary', null);
  Object.assign(legacy, {
    intent: 'Keep the original outcome wording.',
    rationale: 'Keep the original rationale.',
    profile: 'centaur',
    starred: true,
    createdAt: '2026-09-08T10:00:00Z',
    updatedAt: '2026-09-09T11:00:00Z',
    legacyFields: { rankScore: 3.5, originalStatusLabel: 'manual import' },
  });
  legacy.contextHints.sessionIds.push('fixture-legacy-session-hint');
  legacy.sources.push({
    type: 'discussion',
    url: 'https://example.invalid/legacy-discussion',
    title: 'Original source',
    author: null,
    rawSnippet: 'Original source language retained without truncation. '.repeat(8),
    createdAt: null,
    addedAt: null,
    updatedAt: null,
  });
  legacy.links.push({
    type: 'design',
    url: 'https://example.invalid/original-design',
    title: 'Original design title',
    description: 'Original description',
    addedAt: null,
  });
  const legacyUnknown = scenario([legacy]);
  legacyUnknown.snapshots.push({
    version: 1,
    snapshotId: 'fixture-legacy-snapshot',
    itemId: legacy.itemId,
    source: null,
    selection: { kind: 'unknown' },
    adoptedBrief: null,
    artifacts: [],
    author: null,
    sourceCreatedAt: null,
    adoptedAt: null,
  });

  const attemptRecovery = scenario([]);
  const first: TelosWorkAttempt = {
    version: 1,
    requestId: 'fixture-start-request',
    attemptId: 'fixture-attempt-1',
    predecessorAttemptId: null,
    leadConversationId: 'fixture-conversation-lead',
    childItemId: 'fixture-studio-slice',
    contextSnapshotId: 'fixture-studio-slice-snapshot',
    state: 'allocation_uncertain',
    workerConversationId: null,
    allocationReceiptId: null,
    executionTaskId: null,
    accountingGoalId: 'fixture-accounting-goal',
    turnCommandId: null,
  };
  attemptRecovery.attempts.push(first, {
    ...first,
    requestId: 'fixture-explicit-retry-request',
    attemptId: 'fixture-attempt-2',
    predecessorAttemptId: first.attemptId,
    state: 'chat_ready',
    workerConversationId: 'fixture-conversation-worker',
    allocationReceiptId: 'fixture-allocation-receipt',
  });
  return {
    homeStudio,
    leadWithUnstartedSlice,
    multipleChats,
    coordinated,
    nestedCoordinator,
    legacyUnknown,
    attemptRecovery,
  };
}
