import type Database from 'better-sqlite3';

/** Evidence of a single operator submission, never a reusable permission grant. */
export interface NotificationResponseReceipt {
  requestId: string;
  notificationId: string;
  sessionId: string;
  nativeAction: string;
  decision: 'once' | 'always' | 'deny';
  receivedAt: number;
  settledAt?: number;
  status: 'received' | 'settled' | 'rejected' | 'unconfirmed';
  resolution?: 'allowed' | 'denied' | 'expired';
  code?: string;
}

export class NotificationResponseReceipts {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS notification_response_receipts (
      request_id TEXT PRIMARY KEY, notification_id TEXT NOT NULL, session_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, data TEXT NOT NULL
    )`);
  }
  get(requestId: string) {
    const row = this.db
      .prepare('SELECT fingerprint, data FROM notification_response_receipts WHERE request_id=?')
      .get(requestId) as { fingerprint: string; data: string } | undefined;
    return (
      row && {
        fingerprint: row.fingerprint,
        receipt: JSON.parse(row.data) as NotificationResponseReceipt,
      }
    );
  }
  begin(receipt: NotificationResponseReceipt, fingerprint: string): void {
    // Synchronous and durable BEFORE invoking the permission owner. A retained
    // "received" result after interruption must never be executed again.
    this.db
      .prepare('INSERT INTO notification_response_receipts VALUES (?,?,?,?,?)')
      .run(
        receipt.requestId,
        receipt.notificationId,
        receipt.sessionId,
        fingerprint,
        JSON.stringify(receipt),
      );
  }
  finish(receipt: NotificationResponseReceipt): void {
    this.db
      .prepare('UPDATE notification_response_receipts SET data=? WHERE request_id=?')
      .run(JSON.stringify(receipt), receipt.requestId);
  }
}
