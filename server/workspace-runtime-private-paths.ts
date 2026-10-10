/** Discover operator authority before any runtime request or model tool can write it. */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

function privateJson(path: string): Record<string, unknown> {
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    realpathSync(path) !== resolve(path) ||
    file.uid !== process.getuid?.() ||
    file.nlink !== 1 ||
    (file.mode & 0o077) !== 0 ||
    file.size > 64 * 1024
  )
    throw new Error('Workspace runtime authority must be private and physical');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Workspace runtime authority must be an object');
  return value as Record<string, unknown>;
}
function absolute(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value))
    throw new Error('Workspace runtime authority path must be absolute');
  return value;
}
export function configuredWorkspaceRuntimePrivatePaths(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!Object.hasOwn(env, 'MITZO_WORKSPACE_RUNTIME_CONFIG')) return [];
  const enrollmentPath = absolute(env.MITZO_WORKSPACE_RUNTIME_CONFIG);
  const enrollment = privateJson(enrollmentPath);
  if (enrollment.kind !== 'workspace-runtime-v1')
    throw new Error('Unsupported workspace runtime authority');
  const configPath = absolute(enrollment.config);
  const config = privateJson(configPath);
  // Paths that select executable code are operator authority too. Data, domain
  // YAML, report and inbox roots deliberately remain under existing file policy.
  const python = absolute(enrollment.python);
  const environment = dirname(dirname(python));
  return [
    enrollmentPath,
    configPath,
    absolute(enrollment.release),
    python,
    ...(existsSync(join(environment, 'pyvenv.cfg')) ? [environment] : []),
    absolute(config.gwsExecutable),
    absolute(config.jiraLibPath),
  ];
}

const observedAuthority = new Set<string>();
const observedPrivateFiles = new Set<string>();
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), path.slice(parent.length));
  }
}
/** Retain lexical selections and physical targets across re-enrollment/removal.
 * Lexical interpreter/provider links are authority: replacing them changes code.
 */
export function workspaceRuntimeAuthorityPaths(): string[] {
  const configured = configuredWorkspaceRuntimePrivatePaths();
  for (const path of configured.slice(0, 2)) {
    observedPrivateFiles.add(resolve(path));
    observedPrivateFiles.add(canonical(path));
  }
  for (const path of configured) {
    observedAuthority.add(resolve(path));
    // Resolve parent aliases without following the final selected executable
    // link: that directory entry must not be replaceable from its real task root.
    observedAuthority.add(join(canonical(dirname(path)), basename(path)));
    observedAuthority.add(canonical(path));
  }
  return [...observedAuthority];
}
/** Confidential metadata is unreadable; public runtime code may still execute. */
export function workspaceRuntimePrivateFiles(): string[] {
  workspaceRuntimeAuthorityPaths();
  return [...observedPrivateFiles];
}
export function isWorkspaceRuntimeAuthorityWritePath(path: string): boolean {
  const targets = [resolve(path), canonical(resolve(path))];
  return workspaceRuntimeAuthorityPaths().some((authority) =>
    targets.some((target) => target === authority || target.startsWith(authority + '/')),
  );
}
