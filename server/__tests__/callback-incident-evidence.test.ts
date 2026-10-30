import { expect, it, afterEach } from 'vitest';
import {
  inspectCallbackIncidentRollout,
  callbackIncident,
  inspectCallbackIncidentToolEvents,
  incidentHash,
  readStableIncidentFile,
  readCallbackIncidentEvidence,
} from '../callback-incident-evidence.js';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const line = (type: string, payload: object) => JSON.stringify({ type, payload });
const fixture = () =>
  [
    line('session_meta', { id: callbackIncident.threadId, cli_version: '0.160.0' }),
    line('event_msg', { type: 'task_started', turn_id: callbackIncident.turnId }),
    line('event_msg', { type: 'task_complete', turn_id: callbackIncident.turnId }),
  ].join('\n') + '\n';
it('accepts only the original terminal native turn, without projecting conversation text', () => {
  expect(inspectCallbackIncidentRollout(fixture())).toEqual({
    threadId: callbackIncident.threadId,
    turnId: callbackIncident.turnId,
    status: 'completed',
  });
});
it.each([
  () => fixture().replace(callbackIncident.threadId, 'other'),
  () => fixture().replace('0.160.0', 'unknown'),
  () => fixture().replace('task_complete', 'task_failed'),
  () => fixture() + line('event_msg', { type: 'task_started', turn_id: 'newer' }) + '\n',
  () =>
    fixture() +
    line('event_msg', { type: 'task_complete', turn_id: callbackIncident.turnId }) +
    '\n',
  () => fixture() + '{partial',
])('refuses changed, conflicting, newer or incomplete native evidence', (changed) => {
  expect(() => inspectCallbackIncidentRollout(changed())).toThrow();
});
function tools() {
  const input = JSON.stringify({
    operation: 'request_access',
    url: 'https://example.invalid',
    reason: 'fixture',
  });
  const scope = { inputSeq: 10, terminalSeq: 20, callId: 'late', requestHash: incidentHash(input) };
  const receipts = [
    {
      callId: 'prior',
      toolName: 'fixture',
      requestHash: 'fixture',
      resultHash: incidentHash('prior receipt'),
      isError: 0,
    },
    {
      callId: 'late',
      toolName: 'RequestWebAccess',
      requestHash: scope.requestHash,
      resultHash: incidentHash('late receipt'),
      isError: 1,
    },
  ];
  const blocks = [
    { seq: 11, payload: { toolId: 'prior-public', toolName: 'fixture', input: '{}' } },
    { seq: 12, payload: { toolId: 'late-public', toolName: 'RequestWebAccess', input } },
  ];
  const results = [
    { seq: 13, payload: { toolId: 'prior-public', result: 'prior receipt', isError: false } },
    { seq: 21, payload: { toolId: 'late-public', result: 'late receipt', isError: true } },
  ];
  return { scope, receipts, blocks, results };
}
it('correlates all original tool receipts and only the reviewed late in-memory access outcome', () => {
  const f = tools();
  expect(inspectCallbackIncidentToolEvents(f.receipts, f.blocks, f.results, f.scope)).toMatch(
    /^[a-f0-9]{64}$/,
  );
});
it.each([
  'missing',
  'duplicate',
  'second late',
  'early selected',
  'changed input',
  'changed operation',
  'changed tool',
  'changed result',
  'truncated',
])('refuses %s callback evidence', (change) => {
  const f = tools();
  if (change === 'missing') f.results.pop();
  if (change === 'duplicate') f.results.push({ ...f.results[1] });
  if (change === 'second late') f.results[0].seq = 21;
  if (change === 'early selected') f.results[1].seq = 19;
  if (change === 'changed input') f.blocks[1].payload.input = '{}';
  if (change === 'changed operation') {
    f.blocks[1].payload.input = JSON.stringify({ operation: 'fetch' });
    f.scope.requestHash = incidentHash(f.blocks[1].payload.input);
  }
  if (change === 'changed tool') f.blocks[1].payload.toolName = 'OtherTool';
  if (change === 'changed result') f.results[1].payload.result = 'unknown outcome';
  if (change === 'truncated') while (f.results.length < 1024) f.results.push({ ...f.results[0] });
  expect(() =>
    inspectCallbackIncidentToolEvents(f.receipts, f.blocks, f.results, f.scope),
  ).toThrow();
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});
it('bounds evidence reads and refuses symlinks and relative paths', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'incident-file-')));
  roots.push(root);
  const file = join(root, 'source');
  writeFileSync(file, 'bounded');
  expect(readStableIncidentFile(file, 7).toString()).toBe('bounded');
  expect(() => readStableIncidentFile(file, 6)).toThrow('Evidence file unavailable');
  symlinkSync(file, join(root, 'link'));
  expect(() => readStableIncidentFile(join(root, 'link'), 100)).toThrow();
  expect(() => readStableIncidentFile('relative/source', 100)).toThrow(
    'Absolute evidence path required',
  );
  symlinkSync(root, join(root, 'linked-dir'));
  expect(() => readStableIncidentFile(join(root, 'linked-dir', 'source'), 100)).toThrow();
});
it('refuses a changed retained home or an unreviewed original source contract', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'incident-source-')));
  roots.push(root);
  const identity = statSync(root);
  mkdirSync(join(root, 'server'));
  writeFileSync(join(root, 'server/codex-chat-session.ts'), 'unreviewed source');
  const custody = {
    login: { privateHome: root, homeRoot: { dev: identity.dev, ino: identity.ino } },
  };
  expect(() => readCallbackIncidentEvidence(custody as never, root)).toThrow(
    'Original source contract changed',
  );
  custody.login.homeRoot.ino++;
  expect(() => readCallbackIncidentEvidence(custody as never, root)).toThrow(
    'Original native home changed',
  );
});
