import { afterEach, expect, it, vi } from 'vitest';
import { nativeRepositoryReadRootUnion } from '../session-local-repository-tools.js';
import { configuredLocalRepositoryDiscovery } from '../repository-workspace-runtime.js';
import { isAbsolute, relative, sep } from 'node:path';

vi.mock('../repo-config.js', () => ({
  loadRepoConfig: () => ({
    repos: {
      project: '/known/tools/project',
      alias: '/known/tools/project',
      rootRepo: '/root-repo',
    },
    roots: [{ label: 'Projects', path: '/known/projects' }],
  }),
}));
afterEach(() => vi.unstubAllEnvs());
it('uses bounded host locations for uncatalogued names without treating them as read grants', () => {
  vi.stubEnv('REPO_PATH', '/known/primary');
  const projection = configuredLocalRepositoryDiscovery('/tasks/current');
  expect(projection.repositoryCatalog.project).toBe('/known/tools/project');
  expect(projection.discoveryRoots).toEqual(
    expect.arrayContaining(['/known/tools', '/known/projects', '/tasks/current']),
  );
  expect(projection.discoveryRoots).not.toContain('/');
  expect(projection.discoveryRoots.filter((root) => root === '/known/tools')).toHaveLength(1);
  expect(projection).not.toHaveProperty('accessScope');
});

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
