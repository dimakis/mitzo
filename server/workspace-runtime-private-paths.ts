/** Discover operator authority before any runtime request or model tool can write it. */
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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
const observedSelectorEntries = new Set<string>();
const protectedNamespaces = new Set<string>();
const contains = (root: string, path: string) =>
  root === '/' || path === root || path.startsWith(root + '/');
function assertNamespace(root: string): void {
  if (
    canonical(root) !== root ||
    [canonical(tmpdir()), canonical('/tmp')].some((scratch) => contains(root, scratch))
  )
    throw Error('Runtime authority namespace topology changed');
}
/** Called only after the host owner validates an isolated physical state root.
 * This permanently restricts writes; it does not grant reads or execution. */
export function registerWorkspaceRuntimeAuthorityNamespace(path: string): void {
  absolute(path);
  const root = resolve(path);
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root)
    throw Error('Runtime authority namespace must be physical');
  assertNamespace(root);
  observedAuthority.add(root);
  protectedNamespaces.add(root);
}
/** Only qualified namespaces can replace their own changing publication paths.
 * Raw pointers/targets remain in host mutation and workspace-overlap guards. */
export function workspaceRuntimeNativeAuthorityPaths(): string[] {
  const paths = [...workspaceRuntimeAuthorityPaths(), ...observedSelectorEntries];
  for (const root of protectedNamespaces) assertNamespace(root);
  return [
    ...new Set([
      ...protectedNamespaces,
      ...paths.map((path) => {
        const lexical = resolve(path);
        const root = [...protectedNamespaces].find((entry) => contains(entry, lexical));
        if (!root) return path;
        if (!contains(root, observeSelectorLinks(lexical, root)))
          throw Error('Runtime authority selector escaped namespace');
        return root;
      }),
    ]),
  ];
}
/** Resolve component-by-component, reserving every executable pointer entry.
 * Entries are exact pointers, not protected directory subtrees (e.g. /tmp).
 */
function observeSelectorLinks(path: string, namespace?: string) {
  let components = resolve(path).split('/').filter(Boolean);
  let directory = '/';
  let hops = 0;
  while (components.length) {
    const entry = join(directory, components.shift()!);
    let stat;
    try {
      stat = lstatSync(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return join(entry, ...components);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (++hops > 40) throw new Error('Workspace runtime selector link chain is invalid');
      observedSelectorEntries.add(entry);
      const target = readlinkSync(entry);
      const next = isAbsolute(target) ? resolve(target) : resolve(dirname(entry), target);
      if (namespace && !contains(namespace, next))
        throw Error('Runtime authority selector escaped namespace');
      components = [...next.split('/').filter(Boolean), ...components];
      directory = '/';
    } else directory = entry;
  }
  return directory;
}
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
 * Server owners register only their already qualified paths. Private metadata
 * is unreadable as well as unwritable; public executable code stays readable.
 */
export function registerWorkspaceRuntimeAuthorityPaths(
  paths: readonly string[],
  privateFiles: readonly string[] = [],
): void {
  for (const path of privateFiles) {
    absolute(path);
    observedPrivateFiles.add(resolve(path));
    observedPrivateFiles.add(canonical(path));
  }
  for (const path of new Set([...paths, ...privateFiles])) {
    absolute(path);
    observeSelectorLinks(path);
    observedAuthority.add(resolve(path));
    // Resolve parent aliases without following the final selected executable
    // link: that directory entry must not be replaceable from its real task root.
    observedAuthority.add(join(canonical(dirname(path)), basename(path)));
    observedAuthority.add(canonical(path));
  }
}
export function workspaceRuntimeAuthorityPaths(): string[] {
  const configured = configuredWorkspaceRuntimePrivatePaths();
  registerWorkspaceRuntimeAuthorityPaths(configured, configured.slice(0, 2));
  return [...observedAuthority];
}
/** Confidential metadata is unreadable; public runtime code may still execute. */
export function workspaceRuntimePrivateFiles(): string[] {
  workspaceRuntimeAuthorityPaths();
  return [...observedPrivateFiles];
}
export function workspaceRuntimeSelectorEntries(): string[] {
  workspaceRuntimeAuthorityPaths();
  return [...observedSelectorEntries];
}
export function isWorkspaceRuntimeAuthorityWritePath(path: string): boolean {
  const targets = [resolve(path), canonical(resolve(path))];
  return workspaceRuntimeAuthorityPaths().some((authority) =>
    targets.some((target) => target === authority || target.startsWith(authority + '/')),
  );
}
