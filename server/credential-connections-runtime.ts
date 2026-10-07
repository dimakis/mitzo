import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { CredentialConnections, CredentialConnectionStore } from './credential-connections.js';
import { KeychainController } from './keychain-controller.js';
import { MacKeychainVault } from './keychain-vault.js';
import { sendConnectionRequest } from './credential-http.js';

let service: CredentialConnections | null = null;
export function getCredentialConnectionsRuntime() {
  return service;
}
export function setCredentialConnectionsRuntime(next: CredentialConnections | null) {
  service = next;
}
export function keychainConnectionConfig(
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
) {
  if (env.MITZO_KEYCHAIN_CONNECTIONS_ENABLED !== '1') return null;
  if (platform !== 'darwin') throw new Error('Apple Keychain connections require macOS');
  const helper = env.MITZO_KEYCHAIN_HELPER;
  const team = env.MITZO_KEYCHAIN_TEAM_ID;
  const namespace = env.MITZO_KEYCHAIN_CONNECTIONS_NAMESPACE ?? 'default';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace))
    throw new Error('Invalid Keychain controller namespace');
  const directory =
    env.MITZO_KEYCHAIN_CONNECTIONS_DIR ||
    join(homedir(), '.mitzo', 'credential-connections', namespace);
  if (
    !helper ||
    !isAbsolute(helper) ||
    !team ||
    !/^[A-Z0-9]{10}$/.test(team) ||
    !isAbsolute(directory)
  )
    throw new Error(
      'A signed helper, Apple Developer Team ID and private absolute directory are required',
    );
  return {
    helper,
    directory,
    namespace,
    requirement: `identifier "com.mitzo.keychain-helper" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`,
  };
}
export function createCredentialConnectionsRuntime(
  config: NonNullable<ReturnType<typeof keychainConnectionConfig>>,
) {
  const directory = trustedMetadataDirectory(config.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  trustedMetadataDirectory(directory);
  requirePrivateMetadataPath(directory, 0o700);
  const database = join(directory, 'connections.db');
  const files = [database, `${database}-wal`, `${database}-shm`, `${database}-journal`];
  // Existing metadata is an authorization source. Reject unsafe state rather than
  // repairing permissions after another user may already have modified grants.
  for (const file of files) requirePrivateMetadataPath(file, 0o600, true);
  try {
    closeSync(
      openSync(
        database,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  requirePrivateMetadataPath(database, 0o600);
  const store = new CredentialConnectionStore(database);
  try {
    for (const file of files) requirePrivateMetadataPath(file, 0o600, true);
  } catch (error) {
    store.close();
    throw error;
  }
  return {
    store,
    service: new CredentialConnections(
      store,
      new MacKeychainVault(
        config.helper,
        config.requirement,
        undefined,
        undefined,
        new KeychainController(undefined, config.namespace),
      ),
      sendConnectionRequest,
    ),
  };
}

/** Fence every ancestor against replacement by another OS user. Root-owned
 * system aliases (such as macOS /var and /tmp) resolve to checked canonical paths.
 * Sticky root-owned temporary directories protect their current-user children. */
function trustedMetadataDirectory(directory: string): string {
  directory = resolve(directory);
  const root = parse(directory).root;
  const components = directory.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = -1; index < components.length; index++) {
    if (index >= 0) current = join(current, components[index]);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return join(current, ...components.slice(index + 1));
      throw error;
    }
    if (info.isSymbolicLink() && index < components.length - 1) {
      const parent = lstatSync(dirname(current));
      if (info.uid === 0 && parent.uid === 0 && (parent.mode & 0o022) === 0) {
        current = trustedMetadataDirectory(realpathSync(current));
        continue;
      }
    }
    if (
      !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))
    )
      throw new Error(
        'Keychain connection metadata ancestry must be private and owned by the current user or root',
      );
  }
  return current;
}

function requirePrivateMetadataPath(path: string, mode: number, optional = false) {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    (mode === 0o700 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
    (info.mode & 0o777) !== mode ||
    info.uid !== process.getuid?.()
  )
    throw new Error('Keychain connection metadata must be private and owned by the current user');
}
