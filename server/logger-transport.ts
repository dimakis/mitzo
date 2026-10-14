import { write } from 'node:fs';
import type { DestinationStream } from 'pino';

interface LogTransport extends DestinationStream {
  on(event: 'error', listener: (error: unknown) => void): unknown;
}
type FallbackWrite = (line: string, done: () => void) => void;
const MAX_FALLBACK_BYTES = 64 * 1024;

/** Operational logs must not terminate active sessions if a worker/disk fails.
 * Keep fallback buffering bounded even when stderr shares the failed filesystem.
 * This is not used for durable permission or execution audit records.
 */
export function resilientLogDestination(
  transport: LogTransport,
  fallback: FallbackWrite = (line, done) => {
    write(2, line, () => done());
  },
): DestinationStream {
  let failed = false;
  let writing = false;
  let pending = '';
  let dropped = 0;

  function flush() {
    if (writing || (!pending && !dropped)) return;
    const loss = dropped
      ? JSON.stringify({
          level: 40,
          module: 'logger',
          msg: 'Operational log fallback overflow',
          dropped,
        }) + '\n'
      : '';
    const chunk = loss + pending;
    pending = '';
    dropped = 0;
    writing = true;
    try {
      fallback(chunk, () => {
        writing = false;
        flush();
      });
    } catch {
      writing = false;
      // A broken fallback cannot report its own failure recursively.
    }
  }

  function enqueue(line: string) {
    if (Buffer.byteLength(pending) + Buffer.byteLength(line) <= MAX_FALLBACK_BYTES) pending += line;
    else dropped++;
    flush();
  }

  function fail(error: unknown) {
    if (failed) return;
    failed = true;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    enqueue(
      JSON.stringify({
        level: 50,
        module: 'logger',
        msg: 'Operational log transport failed; using bounded stderr fallback',
        code: typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'TRANSPORT_ERROR',
      }) + '\n',
    );
  }
  transport.on('error', fail);
  return {
    write(line: string) {
      if (!failed) {
        try {
          transport.write(line);
          return;
        } catch (error) {
          fail(error);
        }
      }
      enqueue(line);
    },
  };
}
