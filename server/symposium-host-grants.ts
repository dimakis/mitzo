import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AuthorityGrantSchema,
  ContextGrantSchema,
  SeatConfigSchema,
  SymposiumConfigSchema,
  type SeatConfig,
  type SymposiumConfig,
  type SymposiumProfileDefinition,
} from '@mitzo/protocol';

const Id = z.string().trim().min(1);
export const SymposiumProfileSelectionSchema = z.strictObject({
  profileId: Id,
  revision: z.number().int().positive(),
});
export type SymposiumProfileSelection = z.infer<typeof SymposiumProfileSelectionSchema>;
const Authorization = z.strictObject({
  classification: ContextGrantSchema.shape.classification,
  sourceRefs: z.array(Id),
  authority: AuthorityGrantSchema.omit({ grantId: true, revision: true }),
});

export interface SymposiumHostGrantDeps {
  getConfig(sessionId: string): SymposiumConfig | null;
  commitConfig(
    sessionId: string,
    config: SymposiumConfig,
    expectedRevision: number,
  ): SymposiumConfig;
  getMembership(sessionId: string, seatId: string): { generation: number; state: string } | null;
  validateSelection(seat: SeatConfig): void;
  /** Resolves only an immutable revision in the authenticated owner's catalog. */
  resolveProfile?(selection: SymposiumProfileSelection): {
    profileId: string;
    revision: number;
    definition: SymposiumProfileDefinition;
  } | null;
  /** Host policy validates context sources and chooses enforceable authority ceilings. */
  authorizeSeat(input: {
    sessionId: string;
    actor: string;
    seat: SeatConfig;
    contextSourceRefs: string[];
  }): z.infer<typeof Authorization>;
}

type GrantRow = { session_id: string; seat_id: string; seat: string; revoked_at: number | null };
const serializeSeat = (seat: SeatConfig) => JSON.stringify(SeatConfigSchema.parse(seat));

/** Host-issued immutable grants. Config references alone never establish permission. */
export class SymposiumHostGrants {
  private readonly db: Database.Database;

  constructor(
    dbPath: string,
    private readonly deps: SymposiumHostGrantDeps,
  ) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS symposium_host_grants (
      authority_grant_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      seat TEXT NOT NULL,
      issued_by TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      revoked_at INTEGER,
      revoked_by TEXT,
      revocation_reason TEXT
    )`);
  }

  close(): void {
    this.db.close();
  }

  activate(input: {
    sessionId: string;
    expectedRevision: number;
    actor: string;
    contextSourceRefs?: string[];
    profileSelections?: Record<string, SymposiumProfileSelection>;
  }): SymposiumConfig {
    const sessionId = Id.parse(input.sessionId);
    const actor = Id.parse(input.actor);
    const current = this.deps.getConfig(sessionId);
    if (!current || current.revision !== input.expectedRevision)
      throw new Error('Symposium activation revision conflict');
    if (current.version !== 2 || current.state !== 'draft')
      throw new Error('Only a v2 draft can be activated');
    const contextSourceRefs = z
      .array(Id)
      .parse(input.contextSourceRefs ?? [`session:${sessionId}`]);
    const profileSelections = z
      .record(Id, SymposiumProfileSelectionSchema)
      .parse(input.profileSelections ?? {});
    if (
      Object.keys(profileSelections).some(
        (seatId) => !current.seats.some((seat) => seat.id === seatId),
      )
    )
      throw new Error('Profile selection references an unknown seat');
    const domain = `symposium:${randomUUID()}`;
    const seats = current.seats.map((value) =>
      this.mintSeat(
        sessionId,
        actor,
        value,
        contextSourceRefs,
        {
          trustDomainId: domain,
          revision: 1,
          placement: 'reuse-compatible',
        },
        profileSelections[value.id],
      ),
    );
    const next = SymposiumConfigSchema.parse({
      ...current,
      state: 'active',
      revision: current.revision + 1,
      seats,
    });
    this.db
      .transaction(() => {
        const insert = this.db.prepare(`INSERT INTO symposium_host_grants
        (authority_grant_id, session_id, seat_id, seat, issued_by, issued_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
        for (const seat of next.seats)
          insert.run(
            seat.authorityGrant!.grantId,
            sessionId,
            seat.id,
            serializeSeat(seat),
            actor,
            Date.now(),
          );
      })
      .immediate();
    // The config store may use a different SQLite connection. Commit after issuance
    // to avoid nested writer locks. A losing CAS leaves inert, unreferenced records;
    // verifySeat requires the winning durable config and current membership too.
    return this.deps.commitConfig(sessionId, next, input.expectedRevision);
  }

  reviseSeat(input: {
    sessionId: string;
    expectedRevision: number;
    actor: string;
    seat: SeatConfig;
    contextSourceRefs?: string[];
    profileSelection?: SymposiumProfileSelection;
  }): SymposiumConfig {
    const sessionId = Id.parse(input.sessionId);
    const actor = Id.parse(input.actor);
    const current = this.deps.getConfig(sessionId);
    if (!current || current.revision !== input.expectedRevision)
      throw new Error('Symposium revision conflict');
    if (current.version !== 2 || current.state !== 'active')
      throw new Error('Active v2 configuration is required');
    const oldSeat = current.seats.find((seat) => seat.id === input.seat.id);
    if (this.deps.getMembership(sessionId, input.seat.id)?.state === 'active')
      throw new Error('Suspend the active seat before changing its grant');
    const domain = current.seats.find((seat) => seat.id === current.anchorSeatId)?.isolationRequest;
    if (!domain) throw new Error('Shared isolation grant is unavailable');
    const seat = this.mintSeat(
      sessionId,
      actor,
      input.seat,
      z.array(Id).parse(input.contextSourceRefs ?? [`session:${sessionId}`]),
      domain,
      input.profileSelection,
    );
    const next = SymposiumConfigSchema.parse({
      ...current,
      revision: current.revision + 1,
      seats: oldSeat
        ? current.seats.map((value) => (value.id === seat.id ? seat : value))
        : [...current.seats, seat],
    });
    this.db
      .prepare(
        `INSERT INTO symposium_host_grants
      (authority_grant_id, session_id, seat_id, seat, issued_by, issued_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seat.authorityGrant!.grantId,
        sessionId,
        seat.id,
        serializeSeat(seat),
        actor,
        Date.now(),
      );
    const committed = this.deps.commitConfig(sessionId, next, input.expectedRevision);
    // The new durable configuration immediately fences old snapshots, even if
    // the process stops before this audit revocation is recorded.
    if (oldSeat?.authorityGrant)
      this.db
        .prepare(
          `UPDATE symposium_host_grants SET revoked_at = ?, revoked_by = ?,
        revocation_reason = ? WHERE authority_grant_id = ? AND session_id = ? AND revoked_at IS NULL`,
        )
        .run(Date.now(), actor, 'Seat grant superseded', oldSeat.authorityGrant.grantId, sessionId);
    return committed;
  }

  private mintSeat(
    sessionId: string,
    actor: string,
    value: SeatConfig,
    contextSourceRefs: string[],
    isolationRequest: NonNullable<SeatConfig['isolationRequest']>,
    profileSelection?: SymposiumProfileSelection,
  ): SeatConfig {
    const inputSeat = SeatConfigSchema.parse(value);
    const version = profileSelection
      ? this.deps.resolveProfile?.(SymposiumProfileSelectionSchema.parse(profileSelection))
      : null;
    if (profileSelection && !version)
      throw new Error('Selected owner profile revision was not found');
    if (
      profileSelection &&
      version &&
      (version.profileId !== profileSelection.profileId ||
        version.revision !== profileSelection.revision)
    )
      throw new Error('Profile resolver returned a different revision');
    const selected = version?.definition;
    const seat: SeatConfig = selected
      ? SeatConfigSchema.parse({
          ...inputSeat,
          name: selected.name,
          role: selected.role,
          systemPrompt: selected.instructions,
          expectedOutput: selected.expectedOutput,
          acceptanceCriteria: selected.acceptanceCriteria,
        })
      : inputSeat;
    if (seat.profileBinding || seat.contextGrant || seat.authorityGrant || seat.isolationRequest)
      throw new Error('Draft cannot supply host grant or profile references');
    if (!seat.accountBinding) throw new Error('Seat account binding is required');
    if (
      selected?.recipe &&
      !selected.recipe.compatibleProviders.some(
        (provider) => provider === seat.accountBinding!.provider,
      )
    )
      throw new Error('Profile is not compatible with the selected provider');
    this.deps.validateSelection(seat);
    const authorization = Authorization.parse(
      this.deps.authorizeSeat({ sessionId, actor, seat: inputSeat, contextSourceRefs }),
    );
    // A portable role cannot raise the approved seat's executable authority.
    if (
      selected?.role === 'coder' &&
      (authorization.authority.filesystem !== 'write' || authorization.authority.tools !== 'write')
    )
      throw new Error('Coder profile exceeds the approved seat authority ceiling');
    const authority =
      selected && selected.role !== 'coder'
        ? {
            ...authorization.authority,
            filesystem:
              authorization.authority.filesystem === 'write'
                ? ('read' as const)
                : authorization.authority.filesystem,
            tools:
              authorization.authority.tools === 'write'
                ? ('read' as const)
                : authorization.authority.tools,
          }
        : authorization.authority;
    const id = randomUUID();
    const profileHash = createHash('sha256')
      .update(
        JSON.stringify({
          name: seat.name,
          role: seat.role,
          systemPrompt: seat.systemPrompt,
          expectedOutput: seat.expectedOutput,
          acceptanceCriteria: seat.acceptanceCriteria,
        }),
      )
      .digest('hex');
    return {
      ...seat,
      profileBinding:
        selected && profileSelection
          ? {
              profileId: profileSelection.profileId,
              profileRevision: String(profileSelection.revision),
            }
          : { profileId: `host-profile:${profileHash}`, profileRevision: '1' },
      contextGrant: {
        grantId: `context:${id}`,
        revision: 1,
        classification: authorization.classification,
        sourceRefs: authorization.sourceRefs,
      },
      authorityGrant: { grantId: `authority:${id}`, revision: 1, ...authority },
      isolationRequest,
    };
  }

  private requireRegistered(sessionId: string, seat: SeatConfig): void {
    const row = this.db
      .prepare(
        'SELECT session_id, seat_id, seat, revoked_at FROM symposium_host_grants WHERE authority_grant_id = ?',
      )
      .get(seat.authorityGrant?.grantId ?? '') as GrantRow | undefined;
    if (!row || row.session_id !== sessionId || row.seat_id !== seat.id)
      throw new Error('Host seat grant is not registered for this conversation');
    if (row.revoked_at !== null) throw new Error('Host seat grant is revoked');
    if (row.seat !== serializeSeat(seat))
      throw new Error('Seat does not match immutable host grant');
    this.deps.validateSelection(seat);
  }

  validateActiveConfig(sessionId: string, input: SymposiumConfig): void {
    const config = SymposiumConfigSchema.parse(input);
    if (config.state !== 'active') throw new Error('Active config is required');
    const current = this.deps.getConfig(sessionId);
    for (const seat of config.seats) {
      this.requireRegistered(sessionId, seat);
      const existing = current?.seats.find((value) => value.id === seat.id);
      if (!existing || serializeSeat(existing) !== serializeSeat(seat))
        throw new Error('Changed seat grants require host reissuance');
    }
  }

  verifySeat(input: { sessionId: string; seat: SeatConfig; membershipGeneration: number }): void {
    this.requireRegistered(input.sessionId, input.seat);
    const config = this.deps.getConfig(input.sessionId);
    const current = config?.seats.find((seat) => seat.id === input.seat.id);
    if (
      config?.state !== 'active' ||
      !current ||
      serializeSeat(current) !== serializeSeat(input.seat)
    )
      throw new Error('Seat is not the current active configuration');
    const membership = this.deps.getMembership(input.sessionId, input.seat.id);
    if (membership?.state !== 'active' || membership.generation !== input.membershipGeneration)
      throw new Error('Seat membership generation is no longer active');
  }

  revoke(input: {
    sessionId: string;
    authorityGrantId: string;
    actor: string;
    reason: string;
  }): void {
    const actor = Id.parse(input.actor);
    const reason = Id.parse(input.reason);
    const result = this.db
      .prepare(
        `UPDATE symposium_host_grants
      SET revoked_at = ?, revoked_by = ?, revocation_reason = ?
      WHERE authority_grant_id = ? AND session_id = ? AND revoked_at IS NULL`,
      )
      .run(Date.now(), actor, reason, input.authorityGrantId, input.sessionId);
    if (!result.changes) throw new Error('Host grant is absent or already revoked');
  }
}
