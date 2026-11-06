import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const parsed = new Map<string, { bytes: Buffer; result: Promise<string[]> }>();
/** Reuse parsing, never permission or path identity. Callers must freshly
 * qualify and read the file before supplying these exact immutable bytes. */
export async function parseReadOnlyGitConfig(input: Buffer): Promise<string[]> {
  if (input.length > 65536) throw Error('Standalone Git configuration is unavailable');
  const bytes = Buffer.from(input);
  const key = createHash('sha256').update(bytes).digest('hex');
  const previous = parsed.get(key);
  if (previous?.bytes.equals(bytes)) return [...(await previous.result)];
  const result = new Promise<string[]>((resolve, reject) => {
    const child = execFile(
      '/usr/bin/git',
      ['config', '--no-includes', '--file', '-', '--null', '--list'],
      {
        cwd: '/',
        timeout: 5000,
        maxBuffer: 131072,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.split('\0').filter(Boolean));
      },
    );
    child.stdin?.end(bytes);
  });
  const entry = { bytes, result };
  if (parsed.size >= 32) parsed.delete(parsed.keys().next().value!);
  parsed.set(key, entry);
  try {
    return [...(await result)];
  } catch (error) {
    if (parsed.get(key) === entry) parsed.delete(key);
    throw error;
  }
}
