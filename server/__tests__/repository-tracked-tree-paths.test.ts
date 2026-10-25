import { expect, it } from 'vitest';
import {
  validNativeTreeRelativePath,
  validNativeRepositoryTreeRelativePath,
  projectNativeTreeEntries,
  projectNativeRepositoryTreeEntries,
} from '../native-tree-publication.js';
it('allows tracked project instruction/configuration data only in the repository publication projection', () => {
  for (const path of [
    '.claude',
    '.claude/settings.json',
    '.cursor',
    '.cursor/rules',
    '.cursor/rules/ci-discipline.mdc',
    '.codex/config.toml',
  ]) {
    expect(validNativeTreeRelativePath(path)).toBe(false);
    expect(validNativeRepositoryTreeRelativePath(path)).toBe(true);
    const entry = {
      path,
      mode: '100644',
      size: 0,
      sha256: 'a'.repeat(64),
      identity: { dev: '1', ino: '2' },
    };
    const parts = path.split('/');
    const parents = parts
      .slice(0, -1)
      .map((_, index) => ({ ...entry, path: parts.slice(0, index + 1).join('/'), mode: '040000' }));
    expect(() => projectNativeTreeEntries([...parents, entry])).toThrow();
    expect(projectNativeRepositoryTreeEntries([...parents, entry]).at(-1)!.path).toBe(path);
  }
});
it('retains credential, Git metadata, traversal and alias refusals for tracked repository paths', () => {
  for (const path of [
    '.git/config',
    '.aws/credentials',
    '.ssh/id_rsa',
    'src/../outside',
    '.CLAUDE/../outside',
    'src/.git/config',
    'src/.aws/config',
    '.gcloud/token',
    'x/.git~1/config',
  ])
    expect(validNativeRepositoryTreeRelativePath(path), path).toBe(false);
});
