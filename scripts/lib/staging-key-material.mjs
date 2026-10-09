import process from 'node:process';
import { Buffer } from 'node:buffer';
import { join, relative } from 'node:path';
import { readdirSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { bytes, hash, directory, inventory } from './staging-cold-audit.mjs';
/** Exact original frozen launcher schema. No parser may ignore unknown sections,
 * alternate signing paths, extension transports or native persistent state. */
export function verifyFrozenKeyGateway(c, root) {
  directory(root);
  if (c.upstreamProxy !== undefined || c.supervisorNetwork !== undefined)
    throw Error('Only the initial non-proxy gateway contract is qualified');
  const q = JSON.stringify,
    tls = Object.fromEntries(Object.keys(c.tls).map((n) => [n, join(root, n + '.pem')])),
    jwt = Object.fromEntries(Object.keys(c.jwt).map((n) => [n, join(root, n + '.jwt')]));
  const text = bytes(join(root, 'gateway.toml')).toString(),
    issuer = text.match(/^issuer = "(https:\/\/127\.0\.0\.1:[1-9][0-9]{3,4})"$/m)?.[1];
  if (!issuer || Number(issuer.split(':').at(-1)) > 65535)
    throw Error('Exact original issuer required');
  const expected = `
[openshell]
version = 2
[openshell.gateway]
name = ${q(c.gateway)}
bind_address = ${q(`127.0.0.1:${c.port}`)}
compute_driver = "podman"
disable_tls = false
guest_tls_ca = ${q(tls.clientCa)}
guest_tls_cert = ${q(tls.managementCert)}
guest_tls_key = ${q(tls.managementKey)}
[openshell.gateway.mtls_auth]
enabled = false
[openshell.gateway.oidc]
issuer = ${q(issuer)}
audience = "symposium-host"
admin_role = "openshell-admin"
[openshell.gateway.auth]
allow_unauthenticated_users = false
[openshell.gateway.gateway_jwt]
signing_key_path = ${q(jwt.signingKey)}
public_key_path = ${q(jwt.publicKey)}
kid_path = ${q(jwt.kid)}
gateway_id = ${q(c.gateway)}
[openshell.gateway.tls]
cert_path = ${q(tls.serverCert)}
key_path = ${q(tls.serverKey)}
client_ca_path = ${q(tls.clientCa)}
[openshell.drivers.podman]
allow_driver_config = true
enable_bind_mounts = false
socket_path = ${q(c.podmanSocket)}
network_name = ${q(c.network)}
grpc_endpoint = ${q(`https://host.containers.internal:${c.port}`)}
default_image = ${q(c.workloadImage)}
image_pull_policy = "never"
sandbox_runtime_image = ${q(c.sandboxRuntimeImage)}
supervisor_image = ${q(c.supervisorImage)}
[openshell.drivers.podman.resource_admission]
enabled = true
`;
  if (text !== expected) throw Error('Frozen complete native configuration changed');
  const expectedFiles = {
    'openshell-gateway': { sha256: c.executableSha256, mode: 0o500 },
    openshell: { sha256: c.cliSha256, mode: 0o500 },
    'gateway.toml': { sha256: hash(Buffer.from(expected)), mode: 0o400 },
  };
  for (const [name, path] of Object.entries(c.tls))
    expectedFiles[name + '.pem'] = { sha256: hash(bytes(path)), mode: 0o400 };
  for (const [name, path] of Object.entries(c.jwt))
    expectedFiles[name + '.jwt'] = { sha256: hash(bytes(path)), mode: 0o400 };
  const mtls = join('config/openshell/gateways', c.gateway, 'mtls');
  for (const [name, key] of [
    ['ca.crt', 'clientCa'],
    ['tls.crt', 'managementCert'],
    ['tls.key', 'managementKey'],
  ])
    expectedFiles[join(mtls, name)] = { sha256: hash(bytes(c.tls[key])), mode: 0o400 };
  expectedFiles['gateway-trust.pem'] = {
    sha256: hash(
      Buffer.concat([publicRoots(c.systemCaBundle), Buffer.from('\n'), bytes(c.tls.clientCa)]),
    ),
    mode: 0o400,
  };
  const ordered = (v) =>
    JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));
  if (ordered(inventory(root)) !== ordered(expectedFiles))
    throw Error('Frozen launch files, token cache or database changed');
  const dirs = new Set([
    'home',
    'config',
    'state',
    'cache',
    'config/openshell',
    'config/openshell/gateways',
    `config/openshell/gateways/${c.gateway}`,
    mtls,
    'state/openshell',
    'state/openshell/gateway',
  ]);
  function walk(p) {
    for (const n of readdirSync(p)) {
      const path = join(p, n),
        s = lstatSync(path);
      if (s.isDirectory()) {
        const r = relative(root, path);
        if (
          !dirs.delete(r) ||
          (s.mode & 0o777) !== (r === 'state/openshell' ? 0o755 : 0o700) ||
          s.uid !== process.getuid() ||
          realpathSync(path) !== path
        )
          throw Error('Unexpected gateway state directory');
        walk(path);
      }
    }
  }
  walk(root);
  // Runtime defaults can create these empty directories; their absence is allowed.
  for (const d of dirs)
    if (!d.startsWith('state/openshell')) throw Error('Required frozen gateway directory missing');
  const signing = createPrivateKey(bytes(jwt.signingKey)),
    pub = createPublicKey(bytes(jwt.publicKey));
  if (
    signing.asymmetricKeyType !== 'rsa' ||
    pub.asymmetricKeyType !== 'rsa' ||
    !createPublicKey(signing)
      .export({ type: 'spki', format: 'der' })
      .equals(pub.export({ type: 'spki', format: 'der' }))
  )
    throw Error('Only a matching rejected RSA pair qualifies');
  return {
    signingAlgorithm: 'rsa',
    publicAlgorithm: 'rsa',
    gatewayMaterialVerified: true,
    gatewayDatabaseAbsent: true,
    tokenCacheAbsent: true,
    issuer,
  };
}

function publicRoots(path) {
  const canonical = realpathSync(path),
    s = lstatSync(canonical);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.mode & 0o022 ||
    ![0, process.getuid()].includes(s.uid) ||
    s.size > 4 * 1024 * 1024
  )
    throw Error('Public CA trust input changed');
  return readFileSync(canonical);
}
