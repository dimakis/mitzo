import { write } from 'node:fs';
import type { DestinationStream } from 'pino';

interface LogTransport extends DestinationStream {
  on(event: 'error', listener: (error: unknown) => void): unknown;
}
type FallbackWrite = (
  line: string,
  done: (error?: Error | null, bytesWritten?: number) => void,
) => void;
const MAX_FALLBACK_BYTES = 64 * 1024;

/** Operational logs must not terminate active sessions if a worker/disk fails.
 * Keep fallback buffering bounded even when stderr shares the failed filesystem.
 * This is not used for durable permission or execution audit records.
 */
export function resilientLogDestination(
  transport: LogTransport,
  fallback: FallbackWrite = (line, done) => {
    write(2, line, (error, bytesWritten) => done(error, bytesWritten));
  },
): DestinationStream {
  let failed = false;
  let writing = false;
  let pending = '';
  let dropped = 0;
  let failedWrites = 0;
  let lostBytes = 0;
  let partialPrefix = false;
  const add = (value: number, increment: number) =>
    Math.min(Number.MAX_SAFE_INTEGER, value + increment);

  function flush() {
    if (writing || (!pending && !dropped && !failedWrites)) return;
    const previousLoss = { dropped, failedWrites, lostBytes };
    const loss =
      dropped || failedWrites
        ? JSON.stringify({
            level: 40,
            module: 'logger',
            msg: 'Operational log fallback loss',
            dropped,
            failedWrites,
            lostBytes,
          }) + '\n'
        : '';
    const previousPrefix = partialPrefix;
    const chunk = (partialPrefix ? '\n' : '') + loss + pending;
    partialPrefix = false;
    pending = '';
    dropped = 0;
    failedWrites = 0;
    lostBytes = 0;
    writing = true;
    let completed = false;
    const done = (error?: Error | null, bytesWritten?: number) => {
      if (completed) return;
      completed = true;
      writing = false;
      const length = Buffer.byteLength(chunk);
      const written =
        bytesWritten === undefined && !error
          ? length
          : Math.max(0, Math.min(length, bytesWritten ?? 0));
      if (error || written < length) {
        partialPrefix = written === 0 ? previousPrefix : written < length;
        dropped = add(dropped, previousLoss.dropped);
        failedWrites = add(failedWrites, previousLoss.failedWrites + 1);
        lostBytes = add(lostBytes, previousLoss.lostBytes + length - written);
        // Retry only on a subsequent log, not recursively against a full disk.
        return;
      }
      flush();
    };
    try {
      fallback(chunk, done);
    } catch {
      done(new Error('Fallback write failed'));
    }
  }

  function enqueue(line: string) {
    if (Buffer.byteLength(pending) + Buffer.byteLength(line) <= MAX_FALLBACK_BYTES) pending += line;
    else {
      dropped = add(dropped, 1);
      lostBytes = add(lostBytes, Buffer.byteLength(line));
    }
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
