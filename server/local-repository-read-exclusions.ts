import { join, resolve, sep } from 'node:path';

const credentialDirectories = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.gcloud',
  'Keychains',
]);
const agentDirectories = new Set(['.claude', '.cursor', '.codex']);
export const localRepositoryReadDirectoryExclusionNames = Object.freeze([
  ...credentialDirectories,
  ...agentDirectories,
]);
/** Static restrictions only; no filesystem probes or authority grants. */
export function localRepositoryReadDirectoryExclusions(directory: string) {
  return [...credentialDirectories, ...agentDirectories].map((name) => join(directory, name));
}
export function isLocalRepositoryCredentialPath(path: string) {
  const parts = resolve(path).split(sep);
  return parts.some(
    (part, index) =>
      credentialDirectories.has(part) ||
      (agentDirectories.has(part) && parts[index + 1] !== 'worktrees'),
  );
}
