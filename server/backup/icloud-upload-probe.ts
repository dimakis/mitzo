import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { UploadProbe } from './icloud-transport.js';

const response = z.object({ status: z.enum(['uploaded', 'pending', 'unknown']) }).strict();
type Executor = (binary: string, path: string) => Promise<string>;
const execute: Executor = (binary, path) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
    let output = '';
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill('SIGKILL');
    }, 10000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 1024) {
        failed = true;
        child.kill('SIGKILL');
      } else output += chunk.toString();
    });
    child.stdin.on('error', () => {
      failed = true;
      child.kill('SIGKILL');
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Upload evidence unavailable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || failed) reject(new Error('Upload evidence unavailable'));
      else resolve(output);
    });
    child.stdin.end(path + '\n');
  });
export function createICloudUploadProbe(binary: string, run: Executor = execute): UploadProbe {
  if (!isAbsolute(binary)) throw new Error('Upload probe executable must be absolute');
  return async (path) => {
    if (
      !isAbsolute(path) ||
      Buffer.byteLength(path) > 4095 ||
      path.includes('\0') ||
      path.includes('\n')
    )
      return 'unknown';
    try {
      return response.parse(JSON.parse(await run(binary, path))).status;
    } catch {
      return 'unknown';
    }
  };
}
