import { Buffer } from 'node:buffer';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { join, dirname, isAbsolute } from 'node:path';
import { lstatSync, renameSync } from 'node:fs';
import { bytes, hash, directory } from './staging-cold-audit.mjs';
import { exclusive, sync } from './staging-cold-prepare.mjs';
export function deriveKeyConfiguration(root, config, launchId) {
  if (
    !isAbsolute(root) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(launchId ?? '') ||
    !config.gateway?.jwt
  )
    throw Error('Exact private key configuration required');
  const stem = join(root, 'symposium/settings', 'ed25519-' + launchId);
  return {
    ...config,
    gateway: {
      ...config.gateway,
      jwt: {
        signingKey: stem + '.private.pem',
        publicKey: stem + '.public.pem',
        kid: stem + '.kid',
      },
    },
  };
}
/** Called only after preservation/qualification while the original lock remains.
 * Old configured keys are untouched, not overwritten or reused. */
export function installFreshKeyConfiguration(root, path, original, launchId) {
  if (path !== join(root, 'symposium/settings/owned-host.json') || !bytes(path).equals(original))
    throw Error('Original key configuration changed');
  directory(dirname(path));
  const next = deriveKeyConfiguration(root, JSON.parse(original), launchId),
    temporary = path + '.ed25519-' + launchId;
  for (const p of [...Object.values(next.gateway.jwt), temporary])
    if (lstatSync(p, { throwIfNoEntry: false }))
      throw Error('Fresh key/configuration collision; retain partial evidence');
  const pair = generateKeyPairSync('ed25519');
  exclusive(next.gateway.jwt.signingKey, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  exclusive(next.gateway.jwt.publicKey, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  exclusive(next.gateway.jwt.kid, randomUUID() + '\n');
  const data = Buffer.from(JSON.stringify(next, null, 2) + '\n');
  exclusive(temporary, data);
  if (!bytes(path).equals(original))
    throw Error('Original configuration changed during key preparation');
  renameSync(temporary, path);
  sync(dirname(path));
  return {
    freshConfigSha256: hash(data),
    freshKeys: Object.fromEntries(
      Object.entries(next.gateway.jwt).map(([name, p]) => [
        name,
        { path: p, sha256: hash(bytes(p)) },
      ]),
    ),
  };
}
