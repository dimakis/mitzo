import type { FinishedMessage, StreamingMessage, SymposiumProvenance } from '@mitzo/protocol';

const seats = [
  {
    id: 'architect',
    name: 'Architect',
    role: 'architect',
    model: 'claude-sonnet',
    color: '#4477aa',
    accountId: 'vertex-work',
    accountLabel: 'Vertex work',
    provider: 'anthropic-vertex',
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'reviewer',
    model: 'gpt-review',
    color: '#779955',
    accountId: 'openai-api',
    accountLabel: 'OpenAI API',
    provider: 'openai',
  },
  {
    id: 'implementer',
    name: 'Implementer',
    role: 'implementer',
    model: 'gpt-pro',
    color: '#aa7755',
    accountId: 'openai-pro',
    accountLabel: 'OpenAI Pro',
    provider: 'openai-codex',
  },
] as const;
const binding = (seat: (typeof seats)[number]) => ({
  accountId: seat.accountId,
  accountLabel: seat.accountLabel,
  provider: seat.provider,
  model: seat.model,
  profileRevision: 'preview',
});
const provenance = (seat: (typeof seats)[number]): SymposiumProvenance => ({
  version: 2,
  seatId: seat.id,
  seatLabel: seat.name,
  seatRole: seat.role,
  configRevision: 4,
  accountProfileRevision: 'preview',
  seatProfileRevision: 'preview',
  contextGrantRevision: 1,
  authorityGrantRevision: 1,
  isolationDomainId: 'preview-shared',
  isolationDomainRevision: 1,
  membershipGeneration: 1,
  capturedAt: 1,
  accountBinding: binding(seat),
  reasoningEffort: 'medium',
  profileBinding: { profileId: `preview-${seat.id}`, profileRevision: '1' },
  contextGrant: { grantId: 'preview-context', revision: 1 },
  authorityGrant: { grantId: 'preview-authority', revision: 1 },
});
const [architect, reviewer, implementer] = seats;

export const symposiumStatus = (sessionId: string) => ({
  sessionId,
  config: {
    version: 2,
    revision: 4,
    state: 'active',
    anchorSeatId: 'architect',
    activeSeatCap: 3,
    seats: seats.map((seat) => ({
      id: seat.id,
      name: seat.name,
      role: seat.role,
      model: seat.model,
      color: seat.color,
      systemPrompt: '',
      accountBinding: binding(seat),
      profileBinding: { profileId: `preview-${seat.id}`, profileRevision: '1' },
    })),
    turnRules: { mode: 'directed', maxTurns: 8 },
    interceptMode: 'manual',
  },
  profileBindingEnforced: true,
  runtimeAvailable: true,
  reservedSeats: 3,
  capacityRemaining: 0,
  deliveries: [],
  seats: seats.map((seat) => ({
    seatId: seat.id,
    seat: {
      id: seat.id,
      name: seat.name,
      role: seat.role,
      model: seat.model,
      color: seat.color,
      systemPrompt: '',
      accountBinding: binding(seat),
      profileBinding: { profileId: `preview-${seat.id}`, profileRevision: '1' },
    },
    admitted: true,
    membership: { generation: 1, state: 'active', reconciliation: 'confirmed' },
  })),
});

export const symposiumMessages: FinishedMessage[] = [
  {
    messageId: 'brief',
    role: 'user',
    blocks: [
      {
        blockId: 'brief-text',
        blockType: 'text',
        content:
          'Review the proposed API change before implementation. Ask each specialist for a separate view.',
      },
    ],
  },
  {
    messageId: 'architecture',
    role: 'assistant',
    symposiumProvenance: provenance(architect),
    blocks: [
      {
        blockId: 'architecture-text',
        blockType: 'text',
        content:
          'The endpoint needs a stable request key and an explicit owner boundary.\n\n**Plan:** validate the request, persist the intent, then dispatch each reviewer independently.',
      },
      {
        blockId: 'architecture-tool',
        blockType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolId: 'read-architecture',
        toolInput: '{"file":"api.ts"}',
        toolResult: 'Reviewed route contract.',
      },
    ],
  },
  {
    messageId: 'review',
    role: 'assistant',
    symposiumProvenance: provenance(reviewer),
    blocks: [
      {
        blockId: 'review-text',
        blockType: 'text',
        content:
          'I found one blocking edge case: a retry after an uncertain receipt can duplicate work unless the key is durable. Please verify the owner-scoped replay path.',
      },
    ],
  },
  {
    messageId: 'implementation',
    role: 'assistant',
    symposiumProvenance: provenance(implementer),
    blocks: [
      {
        blockId: 'implementation-text',
        blockType: 'text',
        content:
          'The patch is staged for review. Focused checks pass; I am waiting for the reviewer’s final concern before merging.',
      },
    ],
  },
];

export const symposiumLive: Record<string, StreamingMessage> = {
  reviewer: {
    messageId: 'review-live',
    symposiumProvenance: provenance(reviewer),
    blocks: new Map([
      [
        'live-text',
        {
          blockId: 'live-text',
          blockType: 'text',
          content: 'Checking the retry behavior against the revised route…',
          done: false,
        },
      ],
    ]),
    blockOrder: ['live-text'],
  },
};

const items = [
  {
    kind: 'authored',
    eventSeq: 1,
    messageId: 'brief',
    seatId: null,
    content: symposiumMessages[0].blocks[0].content,
    provenance: null,
  },
  {
    kind: 'authored',
    eventSeq: 2,
    messageId: 'architecture',
    seatId: architect.id,
    content: symposiumMessages[1].blocks[0].content,
    provenance: provenance(architect),
  },
  {
    kind: 'recipient-input',
    eventSeq: 3,
    deliveryId: 'received-1',
    attemptId: 1,
    recipientSeatId: reviewer.id,
    sourceSeatId: architect.id,
    sourceMessageId: 'architecture',
    content: 'Review the stable key and owner boundary.',
    receipt: 'received',
    recipientStatus: 'executing',
  },
  {
    kind: 'authored',
    eventSeq: 4,
    messageId: 'review',
    seatId: reviewer.id,
    content: symposiumMessages[2].blocks[0].content,
    provenance: provenance(reviewer),
  },
  {
    kind: 'recipient-input',
    eventSeq: 5,
    deliveryId: 'uncertain-1',
    attemptId: 2,
    recipientSeatId: implementer.id,
    sourceSeatId: reviewer.id,
    sourceMessageId: 'review',
    content: 'Please check duplicate delivery after a reconnect.',
    receipt: 'uncertain',
    recipientStatus: 'recovery_required',
  },
  {
    kind: 'authored',
    eventSeq: 6,
    messageId: 'implementation',
    seatId: implementer.id,
    content: symposiumMessages[3].blocks[0].content,
    provenance: provenance(implementer),
  },
];
export function symposiumPerspective(seatId: string | null) {
  return {
    items: seatId
      ? items.filter((item) =>
          item.kind === 'authored' ? item.seatId === seatId : item.recipientSeatId === seatId,
        )
      : items,
    nextSeq: null,
    queued: [
      {
        deliveryId: 'queued-1',
        recipientSeatId: 'architect',
        proposedContent: 'Please summarize the open decision after review.',
        deliveryStatus: 'staged',
      },
    ],
  };
}

export const previewProposal = {
  proposalId: 'preview-proposal',
  suggestedProfileId: 'security-reviewer',
  state: 'pending',
  definition: {
    name: 'Security reviewer',
    role: 'reviewer',
    instructions: 'Review boundary and retry behavior in a proposed change.',
    expectedOutput: 'Specific findings with evidence',
    acceptanceCriteria: ['Each finding names its trigger and impact'],
    modelPolicyRole: 'reviewer',
  },
};
