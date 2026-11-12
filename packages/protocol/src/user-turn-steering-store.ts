import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CodexSteerInputSchema, type CodexSteerInput } from './codex-steering.js';

type Status = 'claimed' | 'submitted' | 'accepted' | 'rejected';
type Receipt = { input: CodexSteerInput; uuid: string; content: unknown; status: Status };

/** User corrections have their own durable identity. They grant no peer-message
 * consent and can never be replayed as ordinary commands after a restart. */
export class UserTurnSteeringStore {
  constructor(
    private readonly db: Database.Database,
    private readonly project: (
      sessionId: string,
      input: CodexSteerInput,
      status: 'steering' | 'accepted' | 'rejected',
    ) => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_turn_steering (
      request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE, operator_id TEXT NOT NULL,
      input TEXT NOT NULL, input_uuid TEXT NOT NULL UNIQUE, content TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('claimed','submitted','accepted','rejected')));`);
  }
  read(session: string, operator: string, raw: CodexSteerInput): Receipt | undefined {
    const input = CodexSteerInputSchema.parse(raw);
    const row = this.db
      .prepare('SELECT * FROM user_turn_steering WHERE request_id=?')
      .get(input.requestId) as
      | {
          session_id: string;
          operator_id: string;
          input: string;
          input_uuid: string;
          content: string;
          status: Status;
        }
      | undefined;
    if (!row) return;
    if (
      row.session_id !== session ||
      row.operator_id !== operator ||
      !isDeepStrictEqual(JSON.parse(row.input), input)
    )
      throw Error('Original correction identity required');
    return { input, uuid: row.input_uuid, content: JSON.parse(row.content), status: row.status };
  }
  forUuid(session: string, operator: string, uuid: string): Receipt | undefined {
    const row = this.db
      .prepare(
        'SELECT input FROM user_turn_steering WHERE session_id=? AND operator_id=? AND input_uuid=?',
      )
      .get(session, operator, uuid) as { input: string } | undefined;
    return row && this.read(session, operator, JSON.parse(row.input));
  }
  hasRequest(requestId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM user_turn_steering WHERE request_id=?').get(requestId);
  }
  reserve(
    session: string,
    operator: string,
    input: CodexSteerInput,
    prepareContent: () => unknown,
    conflicts: () => boolean,
  ): { receipt: Receipt; created: boolean } {
    return this.db
      .transaction(() => {
        const previous = this.read(session, operator, input);
        if (previous) return { receipt: previous, created: false };
        if (
          conflicts() ||
          this.db
            .prepare('SELECT 1 FROM client_command_claims WHERE client_msg_id=?')
            .get(input.requestId)
        )
          throw Error('Correction identity already reserved');
        const content = prepareContent();
        this.db
          .prepare('INSERT INTO user_turn_steering VALUES(?,?,?,?,?,?,?)')
          .run(
            input.requestId,
            session,
            operator,
            JSON.stringify(CodexSteerInputSchema.parse(input)),
            randomUUID(),
            JSON.stringify(content),
            'claimed',
          );
        this.project(session, input, 'steering');
        return { receipt: this.read(session, operator, input)!, created: true };
      })
      .immediate();
  }
  transition(
    session: string,
    operator: string,
    input: CodexSteerInput,
    status: Exclude<Status, 'claimed'>,
  ) {
    return this.db
      .transaction(() => {
        const receipt = this.read(session, operator, input);
        const expected = status === 'accepted' ? 'submitted' : 'claimed';
        if (!receipt || receipt.status !== expected)
          throw Error('Original correction claim required');
        this.db
          .prepare('UPDATE user_turn_steering SET status=? WHERE request_id=? AND status=?')
          .run(status, input.requestId, expected);
        if (status !== 'submitted') this.project(session, input, status);
      })
      .immediate();
  }
}
