import { basename, dirname } from 'node:path';
import { expect, it } from 'vitest';
import { checkpointDirectoryForConversation } from '../openshell-lifecycle-controller.js';

it('hashes arbitrary conversation IDs before creating checkpoint directories', () => {
  const base = '/private/mitzo';
  const ids = ['../escape', '/absolute/path', '会話/../../escape', 'stable id'];
  const paths = ids.map((id) => checkpointDirectoryForConversation(base, id, 7));
  expect(checkpointDirectoryForConversation(base, ids[0]!, 7)).toBe(paths[0]);
  for (const path of paths) {
    expect(dirname(dirname(path))).toBe(`${base}/openshell-checkpoints`);
    expect(basename(dirname(path))).toMatch(/^[a-f0-9]{64}$/);
    expect(basename(path)).toBe('7');
  }
  expect(paths[0]).not.toBe(paths[1]);
});
