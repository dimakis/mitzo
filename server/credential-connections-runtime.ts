import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  const store = new CredentialConnectionStore(join(config.directory, 'connections.db'));
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
