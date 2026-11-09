import { execFile } from 'node:child_process';
import type { ProtectedSdkCommandRunner } from '../../protected-sdk-command.js';

/** Test double for the protected worker: execute disposable fixture commands.
 * Provider policy and actual OS isolation have their own boundary tests. */
export const sdkProjectCommandFixture: ProtectedSdkCommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const { input, ...execution } = options;
    const child = execFile(
      command,
      args,
      { ...execution, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
