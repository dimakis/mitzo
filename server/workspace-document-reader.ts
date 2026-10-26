import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import {
  OPEN_SHELL_ARTIFACT_HELPER,
  OpenShellArtifactReadError,
} from './openshell-artifact-reader.js';

const execute = promisify(execFile);
/** The caller supplies a verified session root. Same no-follow/size protections as sandbox uploads. */
export async function readHostWorkspaceDocument(root: string, path: string) {
  const { stdout } = await execute(
    'python3',
    ['-I', '-c', OPEN_SHELL_ARTIFACT_HELPER, resolve(root), path],
    { timeout: 15000, maxBuffer: 7 * 1024 * 1024 },
  );
  const value = JSON.parse(stdout);
  if (value.error || value.path !== resolve(root, path) || typeof value.data !== 'string')
    throw new OpenShellArtifactReadError(
      value.error === 'too_large' ? 413 : value.error === 'not_found' ? 404 : 403,
      'Workspace document unavailable',
    );
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.toString('base64') !== value.data)
    throw new OpenShellArtifactReadError(503, 'Invalid workspace document');
  return { path: value.path as string, bytes };
}
