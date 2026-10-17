import { SymposiumConfigSchema, SymposiumProvenanceSchema } from '@mitzo/protocol';
import type { EventStore } from '../../event-store.js';

/** Producer-valid retained native rows; no provider, runtime or model is started. */
export function nativeSourceWriter(events: EventStore, sessionId = 'origin') {
  const seats = ['builder', 'reviewer'].map((id, index) => ({
    id,
    name: id,
    role: index === 0 ? 'primary' : 'reviewer',
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
  events.upsertSession({ sessionId, accountBinding: config.seats[0].accountBinding });
  events.setSymposiumConfig(sessionId, config);
  const provenance = seats.map((seat) =>
    SymposiumProvenanceSchema.parse({
      version: 2,
      seatId: seat.id,
      seatLabel: seat.name,
      seatRole: seat.role,
      membershipGeneration: 1,
      capturedAt: 1,
      configRevision: 1,
      accountProfileRevision: 'account-r1',
      seatProfileRevision: 'profile-r1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'shared',
      isolationDomainRevision: 1,
      accountBinding: seat.accountBinding,
      profileBinding: seat.profileBinding,
      reasoningEffort: null,
      contextGrant: { grantId: seat.contextGrant.grantId, revision: 1 },
      authorityGrant: { grantId: seat.authorityGrant.grantId, revision: 1 },
    }),
  );
  const append = (seat: number, type: string, payload: Record<string, unknown>) =>
    events.appendSymposium(sessionId, type, payload, provenance[seat]);
  const start = (seat: number, messageId: string, text: string) => {
    const sequence = append(seat, 'message_start', { messageId });
    append(seat, 'block_start', { messageId, blockId: messageId + '-text', blockType: 'text' });
    append(seat, 'block_delta', { messageId, blockId: messageId + '-text', delta: text });
    append(seat, 'block_end', { messageId, blockId: messageId + '-text', blockType: 'text' });
    return sequence;
  };
  const end = (seat: number, messageId: string) => append(seat, 'message_end', { messageId });
  return { start, end, provenance };
}
