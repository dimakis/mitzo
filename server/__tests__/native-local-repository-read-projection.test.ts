import { expect, it } from 'vitest';
import { nativeRepositoryReadRootUnion } from '../session-local-repository-tools.js';
import { isAbsolute, relative, sep } from 'node:path';

it.each([
  { roots: ['/', '/workspace', '/workspace'], expected: ['/'] },
  { roots: ['/work/task', '/work', '/workspace'], expected: ['/work', '/workspace'] },
  { roots: ['/work', '/work-two', '/work/task'], expected: ['/work', '/work-two'] },
  { roots: ['/work/task', '/other'], expected: ['/work/task', '/other'] },
])(
  'preserves the immutable read union without redundant positive anchors: $roots',
  ({ roots, expected }) => {
    const input = Object.freeze([...roots]);
    const minimal = nativeRepositoryReadRootUnion(input);
    expect(minimal).toEqual(expected);
    expect(Object.isFrozen(minimal)).toBe(true);
    expect(input).toEqual(roots);
    const contains = (root: string, path: string) => {
      const rest = relative(root, path);
      return !isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`);
    };
    for (const path of [
      '/',
      '/work',
      '/work/task',
      '/work/task/file',
      '/work-two/file',
      '/workspace',
      '/workspace-secret',
      '/other/file',
      '/elsewhere',
    ])
      expect(minimal.some((root) => contains(root, path))).toBe(
        input.some((root) => contains(root, path)),
      );
  },
);
