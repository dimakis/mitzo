import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
/** Read-only path guard enrollment, available before the Library runtime is initialized. */
export function configuredKnowledgeLibraryPrivatePaths(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const path = env.MITZO_KNOWLEDGE_LIBRARY_CONFIG;
  if (!path) return [];
  if (!isAbsolute(path)) throw new Error('Knowledge library config must be absolute');
  const file = lstatSync(path);
  const parent = lstatSync(dirname(path));
  if (
    !file.isFile() ||
    !parent.isDirectory() ||
    realpathSync(path) !== resolve(path) ||
    file.uid !== process.getuid?.() ||
    parent.uid !== process.getuid?.() ||
    (file.mode & 0o077) !== 0 ||
    (parent.mode & 0o077) !== 0 ||
    file.size > 64 * 1024
  )
    throw new Error('Knowledge library enrollment must be private');
  const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !config ||
    typeof config !== 'object' ||
    !('stateDirectory' in config) ||
    typeof config.stateDirectory !== 'string' ||
    !isAbsolute(config.stateDirectory)
  )
    throw new Error('Knowledge library state directory is invalid');
  return [path, config.stateDirectory];
}
