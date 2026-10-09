import { join } from 'node:path';
import { bytes, hash } from './staging-cold-audit.mjs';
import { privateJson } from './staging-files.mjs';
const names = ['deployment.lock', 'topology.json', 'com.mitzo.staging.plist'];
export function controlHashes(directory) {
  return Object.fromEntries(names.map((name) => [name, hash(bytes(join(directory, name)))]));
}
export function verifyControlCopies(directory, expected) {
  if (
    JSON.stringify(Object.keys(expected ?? {}).sort()) !== JSON.stringify([...names].sort()) ||
    names.some(
      (name) =>
        !/^[a-f0-9]{64}$/.test(expected[name]) ||
        hash(bytes(join(directory, name))) !== expected[name],
    )
  )
    throw Error('Preserved control record bytes changed');
}
export function verifyHistoricalControls(directory, s) {
  if (
    JSON.stringify(privateJson(join(directory, 'deployment.lock'))) !== JSON.stringify(s.lock) ||
    JSON.stringify(privateJson(join(directory, 'topology.json'))) !== JSON.stringify(s.topology) ||
    hash(bytes(join(directory, 'com.mitzo.staging.plist'))) !== s.registrationSha256
  )
    throw Error('Preserved historical control records changed');
}
