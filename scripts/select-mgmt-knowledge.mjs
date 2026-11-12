import process from 'node:process';
import { Buffer } from 'node:buffer';
/** Host-only immutable Git data selection. Never execute source repository programs. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  mgmtPolicyPath,
  readMgmtPolicyReceipt,
  mgmtPolicySelectsPath,
} from './lib/mgmt-knowledge-policy.mjs';
const [source, revision, receiptPath] = process.argv.slice(2);
if (
  !isAbsolute(source ?? '') ||
  !isAbsolute(receiptPath ?? '') ||
  !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision ?? '')
)
  throw Error('Immutable MGMT source selection required');
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_ATTR_NOSYSTEM: '1',
});
const git = (args, maxBuffer = 64 * 1024 * 1024) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', source, ...args], {
    env,
    timeout: 30000,
    maxBuffer,
  });
const records = git(['ls-tree', '--full-tree', '-r', '-z', revision])
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .map((record) => {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    return { mode, type, oid, path: record.slice(tab + 1) };
  });
const selected = records.find((record) => record.path === mgmtPolicyPath);
if (!selected || selected.mode !== '100644' || selected.type !== 'blob')
  throw Error('MGMT portable policy must be regular immutable data');
const bytes = git(['cat-file', 'blob', selected.oid], 128 * 1024),
  content = bytes.toString('utf8');
if (!Buffer.from(content).equals(bytes)) throw Error('MGMT portable policy must be UTF-8');
const receipt = {
  path: mgmtPolicyPath,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  content,
};
const policy = readMgmtPolicyReceipt(receipt);
const paths = records.filter((record) => mgmtPolicySelectsPath(record.path, policy));
if (paths.some((record) => record.type !== 'blob' || !['100644', '100755'].includes(record.mode)))
  throw Error('MGMT portable content must be regular Markdown');
writeFileSync(receiptPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
process.stdout.write(paths.length ? paths.map((record) => record.path).join('\0') + '\0' : '');
