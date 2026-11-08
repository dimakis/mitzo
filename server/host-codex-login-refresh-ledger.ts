import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';
import { z } from 'zod';

const Version = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative(),
  tokenPairs: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(32),
});
const State = z.strictObject({ source: Version, home: Version });
export type LoginRefreshState = z.infer<typeof State>;
export const LOGIN_REFRESH_SLOT_BYTES = 16 * 1024;
export const LOGIN_REFRESH_LEDGER_BYTES = 2 * LOGIN_REFRESH_SLOT_BYTES;
const Record = z.strictObject({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: State,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
type Entry = z.infer<typeof Record> & { slot: number };
export function syncLoginRefreshDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const digest = (sequence: number, state: LoginRefreshState) =>
  createHash('sha256')
    .update(JSON.stringify([sequence, state]))
    .digest('hex');
function encode(sequence: number, state: LoginRefreshState): Buffer {
  state = State.parse(state);
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw Error('Login refresh ledger unavailable');
  const data = Buffer.from(JSON.stringify({ sequence, state, sha256: digest(sequence, state) }));
  if (data.length > LOGIN_REFRESH_SLOT_BYTES) throw Error('Login refresh ledger unavailable');
  const bytes = Buffer.alloc(LOGIN_REFRESH_SLOT_BYTES, ' ');
  data.copy(bytes);
  return bytes;
}
/** Fixed-size slots preserve the anchored file inode. A torn inactive write can
 * never destroy the last accepted version. Checksums detect incomplete writes;
 * physical custody and signed refresh validation supply authority separately. */
export function initialLoginRefreshLedger(state: LoginRefreshState): Buffer {
  const bytes = Buffer.alloc(LOGIN_REFRESH_LEDGER_BYTES, ' ');
  encode(0, state).copy(bytes);
  return bytes;
}
export function readLoginRefreshLedger(bytes: Buffer): Entry {
  if (bytes.length !== LOGIN_REFRESH_LEDGER_BYTES) throw Error('Login refresh ledger unavailable');
  const valid: Entry[] = [];
  for (let slot = 0; slot < 2; slot++) {
    try {
      const value = Record.parse(
        JSON.parse(
          bytes
            .subarray(slot * LOGIN_REFRESH_SLOT_BYTES, (slot + 1) * LOGIN_REFRESH_SLOT_BYTES)
            .toString('utf8'),
        ),
      );
      if (value.sequence % 2 === slot && value.sha256 === digest(value.sequence, value.state))
        valid.push({ ...value, slot });
    } catch {
      /* An inactive slot may contain an interrupted write. */
    }
  }
  if (!valid.length) throw Error('Login refresh ledger unavailable');
  return valid.sort((a, b) => b.sequence - a.sequence)[0];
}
export function writeLoginRefreshLedger(
  fd: number,
  previous: Entry,
  state: LoginRefreshState,
): void {
  const sequence = previous.sequence + 1;
  const bytes = encode(sequence, state);
  const offset = (1 - previous.slot) * LOGIN_REFRESH_SLOT_BYTES;
  if (writeSync(fd, bytes, 0, bytes.length, offset) !== bytes.length)
    throw Error('Login refresh ledger unavailable');
  fsyncSync(fd);
}
