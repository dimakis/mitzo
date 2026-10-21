import { homedir } from 'node:os';
import { z } from 'zod';
import type { CredentialConnections, CredentialConnectionStore } from './credential-connections.js';
import { OpenShellOperatorTransport } from './openshell-operator-transport.js';
import { OpenShellSecretVault } from './openshell-secret-vault.js';
import { openShellSecretService } from './openshell-secret-protocol.js';
import { SecretRelays } from './secret-relay.js';
export function secretRelayConfig(env: NodeJS.ProcessEnv) {
  if (env.MITZO_SECRET_RELAY_ENABLED !== '1') return null;
  const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
  return z
    .object({
      gateway: name,
      workspace: name,
      protocol: z.literal('openshell-operator-credentials-v1'),
    })
    .parse({
      gateway: env.MITZO_SECRET_RELAY_GATEWAY,
      workspace: env.MITZO_SECRET_RELAY_WORKSPACE,
      protocol: env.MITZO_SECRET_RELAY_PROTOCOL,
    });
}
export function attachSecretRelay(
  service: CredentialConnections,
  store: CredentialConnectionStore,
  env: NodeJS.ProcessEnv,
) {
  const config = secretRelayConfig(env);
  if (!config) return;
  const transport = new OpenShellOperatorTransport({
    ...config,
    home: homedir(),
    protocol: 'openshell-v1',
  });
  const vault = new OpenShellSecretVault(
    config.gateway,
    config.workspace,
    (method, request, signal) => transport.request(openShellSecretService[method], request, signal),
  );
  service.relay = new SecretRelays(
    store,
    vault,
    (id) => service.connection(id),
    (...args) => service.applyRelayTarget(...args),
  );
}
