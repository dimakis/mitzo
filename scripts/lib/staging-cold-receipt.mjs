import { Buffer } from 'node:buffer';
import { lstatSync } from 'node:fs';
import { privateJson } from './staging-files.mjs';
import { bytes } from './staging-cold-audit.mjs';
import { exclusive } from './staging-cold-prepare.mjs';
export function recordOrVerifyFreshOwnerReceipt(path, value) {
  const expected = JSON.stringify(value) + '\n';
  if (lstatSync(path, { throwIfNoEntry: false })) {
    privateJson(path);
    if (!bytes(path).equals(Buffer.from(expected)))
      throw Error('Existing verified identity differs; retain lock');
  } else exclusive(path, expected);
}
