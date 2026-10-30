import { hostKnowledgePublication } from './fixtures/host-knowledge-publication.js';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  installHostKnowledgeStore,
  prepareHostKnowledge,
  readHostKnowledge,
} from '../published-host-knowledge.js';

let root: string;
const disposals: Array<() => void> = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'host-knowledge-')));
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  rmSync(root, { recursive: true, force: true });
});

it('clears the prior view when preparing a later turn fails', async () => {
  const first = hostKnowledgePublication(root, 'a', 'Accepted');
  const reconcile = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(Error('offline'));
  disposals.push(installHostKnowledgeStore({ id: 'mgmt', reconcile }));
  const session = {};
  await prepareHostKnowledge(session, false, new AbortController().signal);
  await expect(prepareHostKnowledge(session, false, new AbortController().signal)).rejects.toThrow(
    'offline',
  );
  expect(await readHostKnowledge(session)).toBeUndefined();
});

it('does not deliver a selection after enrollment revocation or cancellation', async () => {
  const publication = hostKnowledgePublication(root, 'a', 'Accepted');
  let deliver!: (value: typeof publication) => void;
  const reconcile = vi.fn(
    () =>
      new Promise<typeof publication>((resolve) => {
        deliver = resolve;
      }),
  );
  const restore = installHostKnowledgeStore({ id: 'mgmt', reconcile });
  disposals.push(restore);
  const session = {};
  const selecting = prepareHostKnowledge(session, false, new AbortController().signal);
  restore();
  deliver(publication);
  await expect(selecting).rejects.toThrow('enrollment changed');
  expect(await readHostKnowledge(session)).toBeUndefined();
  const signal = AbortSignal.abort();
  disposals.push(
    installHostKnowledgeStore({ id: 'mgmt', reconcile: vi.fn().mockResolvedValue(publication) }),
  );
  await expect(prepareHostKnowledge(session, false, signal)).rejects.toThrow();
  expect(await readHostKnowledge(session)).toBeUndefined();
});

it('pins an active turn and refreshes the next one without refetching on tool reads or touching task files', async () => {
  const first = hostKnowledgePublication(root, 'a', 'First accepted memory');
  const second = hostKnowledgePublication(root, 'b', 'Second accepted memory');
  const reconcile = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  disposals.push(installHostKnowledgeStore({ id: 'mgmt', reconcile }));
  const session = {};
  expect(
    (await prepareHostKnowledge(session, true, new AbortController().signal))?.sourceCommit,
  ).toBe(first.sourceCommit);
  expect((await readHostKnowledge(session, 'memory/Observations/lesson.md'))?.content).toBe(
    'First accepted memory',
  );
  expect(reconcile).toHaveBeenCalledOnce();
  await prepareHostKnowledge(session, true, new AbortController().signal);
  expect((await readHostKnowledge(session, 'memory/Observations/lesson.md'))?.content).toBe(
    'Second accepted memory',
  );
  expect(reconcile).toHaveBeenCalledTimes(2);
  writeFileSync(join(second.seed, 'memory/Observations/lesson.md'), 'corrupt');
  await expect(readHostKnowledge(session, 'memory/Observations/lesson.md')).rejects.toThrow();
  await expect(readHostKnowledge(session, '../baseline.json')).rejects.toThrow();
});
