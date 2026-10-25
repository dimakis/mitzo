import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import * as boundaries from '../../../../server/credential-sdk-boundary.js';

/** Observe the original private CLI child and its actual close event. Arguments,
 * environment, authority, return values and errors remain those of the real
 * protected SDK boundary. Only this synthetic fixture's CLI stderr is retained.
 */
export function observePrivateCanonicalCommands(input: {
  scriptPath: string;
  databasePath: string;
  evidenceDirectory?: string;
}) {
  const pending = new Set<Promise<void>>();
  const diagnosticWriteErrors: unknown[] = [];
  const original = boundaries.runtimeFilesystemSdkBoundary;
  vi.spyOn(boundaries, 'runtimeFilesystemSdkBoundary').mockImplementation((...args) => {
    const boundary = original(...args);
    if (!boundary) return boundary;
    const spawn = boundary.spawnClaudeCodeProcess.bind(boundary);
    vi.spyOn(boundary, 'spawnClaudeCodeProcess').mockImplementation((options) => {
      const selected =
        options.args?.[0] === input.scriptPath && options.env?.TELOS_DB_PATH === input.databasePath;
      const started = performance.now();
      const record = (detail: object) => {
        if (!selected || !input.evidenceDirectory) return;
        try {
          appendFileSync(
            join(input.evidenceDirectory, 'canonical-command-processes.jsonl'),
            JSON.stringify({
              phase: 'canonical-read-cli',
              elapsedMs: performance.now() - started,
              ...detail,
            }) + '\n',
          );
        } catch (error) {
          // Diagnostics cannot change the real child's command result/events.
          diagnosticWriteErrors.push(error);
        }
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(options);
      } catch (error) {
        record({
          event: 'spawn-error',
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  code: 'code' in error ? error.code : undefined,
                }
              : String(error),
        });
        throw error;
      }
      child.once('error', (error: Error & { code?: string }) => {
        record({
          event: 'process-error',
          error: { name: error.name, message: error.message, code: error.code },
        });
      });
      let stderr = '';
      if (selected)
        child.stderr.on('data', (bytes: Buffer) => {
          stderr = (stderr + bytes.toString()).slice(0, 16384);
        });
      let complete!: () => void;
      const closed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      pending.add(closed);
      child.once('close', (code, signal) => {
        record({ event: 'close', code, signal, ...(code !== 0 || signal ? { stderr } : {}) });
        pending.delete(closed);
        complete();
      });
      return child;
    });
    return boundary;
  });
  return async () => {
    while (pending.size) await Promise.all([...pending]);
    if (diagnosticWriteErrors.length)
      throw new AggregateError(diagnosticWriteErrors, 'Private command diagnostics failed');
  };
}
