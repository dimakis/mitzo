import { join } from 'node:path';
import { lstatSync, readdirSync } from 'node:fs';
import { bytes, hash, directory } from './staging-cold-audit.mjs';
const names = ['signingKey', 'publicKey', 'kid'];
export function originalKeyRecords(config) {
  return Object.fromEntries(
    names.map((name) => {
      const path = config.gateway.jwt[name],
        s = lstatSync(path);
      if (s.mode & 0o077) throw Error('Original key must remain private');
      return [name, { path, sha256: hash(bytes(path)), mode: s.mode & 0o777 }];
    }),
  );
}
export function verifyOriginalKeyRetention(archive, records, config) {
  const parent = join(archive, 'original-keys');
  directory(parent);
  if (
    JSON.stringify(Object.keys(records ?? {}).sort()) !== JSON.stringify([...names].sort()) ||
    JSON.stringify(readdirSync(parent).sort()) !== JSON.stringify([...names].sort())
  )
    throw Error('Complete original key preservation required');
  for (const name of names) {
    const r = records[name];
    if (
      r.path !== config.gateway.jwt[name] ||
      !/^[a-f0-9]{64}$/.test(r.sha256) ||
      !Number.isInteger(r.mode) ||
      r.mode & 0o077
    )
      throw Error('Original key binding changed');
    for (const path of [r.path, join(parent, name)])
      if ((lstatSync(path).mode & 0o777) !== r.mode || hash(bytes(path)) !== r.sha256)
        throw Error('Original private key bytes or archival copy changed');
  }
}
