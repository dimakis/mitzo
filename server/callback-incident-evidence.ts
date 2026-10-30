import { createHash } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, parse } from 'node:path';
import type { HostCodexCustody } from './host-codex-custody.js';

/** A single reviewed historical incident, never a generic clear-ambiguity grant. */
export const callbackIncident = Object.freeze({
  sessionId: 'ce932ac5-186e-87be-96b6-e09968c5d87f',
  commandId: '69fc48df-f363-42fc-8116-aa8282d49466',
  threadId: '01a18c39-55d8-7801-a639-c8e9af448a91',
  turnId: '01a18c76-48c7-7f70-90bc-e41f8f29fd70',
  generation: 2,
  attempt: 1,
  terminalSeq: 3673717,
  inputSeq: 3672817,
  toolsHash: 'b59e6ab7d0d476feb0c1ec6119d0afb9b6e6ac22698557640fdd664b679c9175',
  callId: 'exec-c2f009ad-d112-447a-9612-eb7016eb1e2f',
  requestHash: '0e89b1cb17fbb6e2e622835e6d66aeaae637cb27c7a548ed9d902ebd70b68545',
  result: 'URL access request could not be completed. Check the URL and session before retrying.',
  workspaceId: '59638250-048a-87d8-bccb-e82f406bcb1d',
  queuedIds: [
    'e962a9b2-551d-476e-b054-a3ecc727ac49',
    'a40209a2-f4ac-4e03-81f6-c9a52eb6a8d0',
  ] as readonly string[],
  rollout:
    'sessions/2026/10/30/rollout-2026-10-30T09-52-10-01a18c39-55d8-7801-a639-c8e9af448a91.jsonl',
  rolloutHash: 'b7ba0bb86f07eafd0fcd5451a6b2127711b93f5ac8dea78f17cb6ea2070f4a03',
  sourceRevision: '9343f44c79058fffa3533391f1b83c456ec36fe9',
  sources: Object.freeze({
    'server/codex-chat-session.ts':
      '19d61e359bfa902a533ce0fa2df5117e5ffc58a0dc0d5d8efd76b0c265382322',
    'server/native-hooks.ts': 'f857e17f9819b4e1e0ab19fb4cd74510f4ff37a307003929c8e5518307864e86',
    'server/url-access-tool.ts': '045e01d27a5c5428b9430e440916875a622ea8eb90f598c577d22a2da680a457',
    'server/codex-conversation.ts':
      '2ecd325ce5aaba32a01b783bfce0508cff07a7579b988b650dfef8177bca06da',
    'server/codex-conversation-store.ts':
      '5169c6c862775d5b9f155b8a0fba23e4051bcd06232a992bb7784a54010919e7',
  }),
});
export const incidentHash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export interface IncidentToolReceipt {
  callId: string;
  toolName: string;
  requestHash: string;
  resultHash: string;
  isError: number;
}
export function inspectCallbackIncidentToolEvents(
  receipts: IncidentToolReceipt[],
  blocks: Array<{ seq: number; payload: Record<string, unknown> }>,
  results: Array<{ seq: number; payload: Record<string, unknown> }>,
) {
  if (!receipts.length || blocks.length >= 1024 || results.length >= 1024)
    throw Error('Tool evidence bound exceeded');
  const used = new Set<number>();
  const observed = receipts.map((receipt) => {
    const matches = results
      .filter(
        (result) =>
          result.seq > callbackIncident.inputSeq &&
          result.seq <= callbackIncident.terminalSeq + 1 &&
          typeof result.payload.result === 'string' &&
          incidentHash(result.payload.result) === receipt.resultHash &&
          Number(result.payload.isError) === receipt.isError,
      )
      .flatMap((result) =>
        blocks
          .filter(
            (block) =>
              !used.has(block.seq) &&
              block.seq > callbackIncident.inputSeq &&
              result.payload.toolId === block.payload.toolId,
          )
          .map((block) => ({ block, result })),
      );
    if (matches.length !== 1) throw Error('Original tool evidence is not unique');
    const { block, result } = matches[0];
    used.add(block.seq);
    if (
      block.seq >= callbackIncident.terminalSeq ||
      result.seq <= block.seq ||
      (receipt.callId === callbackIncident.callId
        ? result.seq !== callbackIncident.terminalSeq + 1
        : result.seq >= callbackIncident.terminalSeq)
    )
      throw Error('Original tool settlement order changed');
    if (
      receipt.callId === callbackIncident.callId &&
      (block.payload.toolName !== 'RequestWebAccess' ||
        typeof block.payload.input !== 'string' ||
        incidentHash(block.payload.input) !== callbackIncident.requestHash ||
        JSON.parse(block.payload.input).operation !== 'request_access')
    )
      throw Error('Historical operation is not read-access resolution');
    return { callId: receipt.callId, block: block.seq, result: result.seq };
  });
  return incidentHash(JSON.stringify(observed));
}

/** Structural native events only. No assistant/user narrative is projected. */
export function inspectCallbackIncidentRollout(source: string) {
  if (!source.endsWith('\n') || Buffer.byteLength(source) > 64 * 1024 * 1024)
    throw Error('Incomplete native evidence');
  const lines = source.trimEnd().split('\n');
  const header = JSON.parse(lines.shift()!);
  if (
    header.type !== 'session_meta' ||
    header.payload?.id !== callbackIncident.threadId ||
    header.payload.cli_version !== '0.160.0'
  )
    throw Error('Native format or thread changed');
  let started = false;
  let completed = false;
  let latest: string | undefined;
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type !== 'event_msg') continue;
    const payload = event.payload;
    if (payload?.type === 'task_started') {
      if (completed) throw Error('Later native task exists');
      latest = payload.turn_id;
      if (latest === callbackIncident.turnId) {
        if (started) throw Error('Conflicting task start');
        started = true;
      }
    } else if (payload?.type === 'task_complete' && payload.turn_id === callbackIncident.turnId) {
      if (!started || completed || latest !== callbackIncident.turnId)
        throw Error('Conflicting native terminal');
      completed = true;
    } else if (
      started &&
      ['task_failed', 'task_interrupted', 'turn_aborted'].includes(payload?.type)
    )
      throw Error('Conflicting native outcome');
  }
  if (!completed || latest !== callbackIncident.turnId)
    throw Error('Exact native terminal unavailable');
  return {
    threadId: callbackIncident.threadId,
    turnId: callbackIncident.turnId,
    status: 'completed' as const,
  };
}

/** No symlink traversal, caller-selected rollout paths, or unstable file reads. */
function readStable(path: string, maxBytes: number): Buffer {
  let parent = dirname(path);
  while (parent !== parse(parent).root) {
    if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent)
      throw Error('Evidence directory changed');
    parent = dirname(parent);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes) || before.nlink !== 1n)
      throw Error('Evidence file unavailable');
    const content = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)
      if (before[key] !== after[key] || before[key] !== current[key])
        throw Error('Evidence changed during observation');
    return content;
  } finally {
    closeSync(fd);
  }
}

export function readCallbackIncidentEvidence(
  custody: HostCodexCustody,
  originalSourceRoot: string,
) {
  const root = lstatSync(custody.login.privateHome);
  if (
    root.dev !== custody.login.homeRoot.dev ||
    root.ino !== custody.login.homeRoot.ino ||
    realpathSync(custody.login.privateHome) !== custody.login.privateHome
  )
    throw Error('Original native home changed');
  // These exact accepted sources positively disable project hooks for owned
  // local Codex and implement request_access as in-memory grant resolution.
  for (const [file, expected] of Object.entries(callbackIncident.sources))
    if (incidentHash(readStable(join(originalSourceRoot, file), 2 * 1024 * 1024)) !== expected)
      throw Error('Original source contract changed');
  const rollout = readStable(
    join(custody.login.privateHome, callbackIncident.rollout),
    64 * 1024 * 1024,
  );
  if (incidentHash(rollout) !== callbackIncident.rolloutHash)
    throw Error('Retained native history changed');
  inspectCallbackIncidentRollout(rollout.toString('utf8'));
  return incidentHash(JSON.stringify({ incident: callbackIncident, home: custody.login.homeRoot }));
}
