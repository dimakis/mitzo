import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  parsePortableSpokePolicyText,
  portableSpokePathSelected,
  portableSpokePathPermitted,
} from './portable-spoke-policy.mjs';
export const mgmtPolicyPath = 'knowledge-publication-policy.json';
export const mgmtRequiredPrivateRoots = ['career', 'direct_reports', 'okrs/private_eng_excellence'];
const guidance = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'CONSTITUTION.md',
  'KNOWLEDGE.md',
  'SERVICES.md',
  'README.md',
]);
export function readMgmtPolicyReceipt(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== 'content,path,sha256' ||
    value.path !== mgmtPolicyPath ||
    typeof value.content !== 'string' ||
    Buffer.byteLength(value.content) > 128 * 1024 ||
    value.sha256 !== createHash('sha256').update(value.content).digest('hex')
  )
    throw Error('MGMT portable policy receipt differs from its source');
  return parsePortableSpokePolicyText(value.content, mgmtRequiredPrivateRoots);
}
export function mgmtPolicySelectsPath(path, policy) {
  if (
    !portableSpokePathPermitted(policy, path) ||
    path.startsWith('memory/scripts/') ||
    path.startsWith('memory/manifest/')
  )
    return false;
  return (
    guidance.has(path) ||
    (path.startsWith('memory/') &&
      !path.startsWith('memory/scripts/') &&
      !path.startsWith('memory/manifest/')) ||
    portableSpokePathSelected(policy, path)
  );
}
