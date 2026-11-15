import type Database from 'better-sqlite3';
import { validateExecutionAdmission } from './execution-ledger.js';

/** Durable non-delivery fencing. The owner supplies current conversation
 * authorization; this store owns atomic withdrawal versus global admission. */
export class OrdinaryCommandWithdrawals {
  constructor(
    private readonly owners: {
      database(): Database.Database;
      hasConversation(id: string): boolean;
      hasSendCommand(id: string): boolean;
      claimCommand(id: string, fingerprint: string): void;
    },
  ) {}
  assertOpen(clientMsgId: string) {
    if (
      this.owners
        .database()
        .prepare('SELECT 1 FROM ordinary_command_withdrawals WHERE client_msg_id=?')
        .get(clientMsgId)
    )
      throw Error('Command was withdrawn before admission');
  }

  /** The authenticated caller qualifies conversation ownership and hashes the
   * exact frozen wire. This transaction races admission through the global
   * command claim; absence observed outside it is never withdrawal authority. */
  withdraw(input: { clientMsgId: string; sessionId: string; wireFingerprint: string }): boolean {
    validateExecutionAdmission(input.clientMsgId, input.wireFingerprint);
    if (
      !/^[a-f0-9]{64}$/.test(input.wireFingerprint) ||
      !this.owners.hasConversation(input.sessionId)
    )
      throw Error('Original withdrawal conversation required');
    return this.owners
      .database()
      .transaction(() => {
        const previous = this.owners
          .database()
          .prepare(
            'SELECT session_id, wire_fingerprint FROM ordinary_command_withdrawals WHERE client_msg_id=?',
          )
          .get(input.clientMsgId) as { session_id: string; wire_fingerprint: string } | undefined;
        if (previous) {
          if (
            previous.session_id !== input.sessionId ||
            previous.wire_fingerprint !== input.wireFingerprint
          )
            throw Error('Original withdrawal identity required');
          return true;
        }
        if (
          this.owners.hasSendCommand(input.clientMsgId) ||
          this.owners
            .database()
            .prepare('SELECT 1 FROM client_command_claims WHERE client_msg_id=?')
            .get(input.clientMsgId) ||
          this.owners
            .database()
            .prepare('SELECT 1 FROM execution_admissions WHERE client_msg_id=?')
            .get(input.clientMsgId)
        )
          return false;
        this.owners.claimCommand(input.clientMsgId, `withdrawn:${input.wireFingerprint}`);
        this.owners
          .database()
          .prepare(
            'INSERT INTO ordinary_command_withdrawals (client_msg_id,session_id,wire_fingerprint) VALUES (?,?,?)',
          )
          .run(input.clientMsgId, input.sessionId, input.wireFingerprint);
        return true;
      })
      .immediate();
  }
}
