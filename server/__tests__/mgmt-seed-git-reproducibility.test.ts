import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('builds identical portable Git bytes without host clocks, configuration or index stat caches', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-seed-git-'));
  try {
    // Execute the actual builder's portable Git stage. The paired publisher
    // acceptance fixture additionally compares the complete generated seed.
    const script = readFileSync(
      resolve('docs/spikes/openshell-codex/prepare-mgmt-knowledge.sh'),
      'utf8',
    );
    const gitStage = script.slice(
      script.indexOf('# Create a fresh portable repository'),
      script.indexOf('\nSOURCE_REPO="$source_repo" WORKSPACE="$workspace" BASELINE='),
    );
    expect(gitStage).toContain('chore: seed isolated MGMT workspace');
    const source = join(root, 'source');
    mkdirSync(source);
    execFileSync('git', ['init', '-q', source]);
    writeFileSync(join(source, 'README.md'), '# Source\n');
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync(
      'git',
      [
        '-C',
        source,
        '-c',
        'user.name=Source',
        '-c',
        'user.email=source@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'source',
      ],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2001-01-01T00:00:00+0000',
          GIT_COMMITTER_DATE: '2001-01-01T00:00:00+0000',
        },
      },
    );
    const starting = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const workspaces = ['first', 'second'].map((name) => join(root, name));
    for (const [index, workspace] of workspaces.entries()) {
      mkdirSync(workspace);
      const hostConfig = join(root, `host-config-${index}`);
      mkdirSync(join(hostConfig, 'git'), { recursive: true });
      writeFileSync(join(hostConfig, 'git/ignore'), index ? 'README.md\n' : '');
      writeFileSync(join(workspace, 'CLAUDE.md'), '# Portable guidance\n');
      writeFileSync(join(workspace, '.gitignore'), 'ignored-local.md\n');
      writeFileSync(join(workspace, 'ignored-local.md'), 'Ignored by committed rule\n');
      writeFileSync(join(workspace, 'README.md'), '# Portable knowledge\n');
      chmodSync(join(workspace, 'README.md'), 0o644);
      execFileSync('bash', ['-euc', gitStage], {
        env: {
          ...process.env,
          workspace,
          XDG_CONFIG_HOME: hostConfig,
          source_repo: source,
          starting_commit: starting,
          GIT_AUTHOR_DATE: `${index ? '2030' : '2000'}-01-01T00:00:00+0000`,
          GIT_COMMITTER_DATE: `${index ? '2030' : '2000'}-01-01T00:00:00+0000`,
          GIT_AUTHOR_NAME: `Host ${index}`,
          GIT_AUTHOR_EMAIL: `host${index}@example.invalid`,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'init.defaultBranch',
          GIT_CONFIG_VALUE_0: index ? 'host-other' : 'host-first',
        },
      });
    }
    const files = (directory: string): Record<string, { bytes: string; mode: number }> => {
      const result: Record<string, { bytes: string; mode: number }> = {};
      const visit = (path: string, relative = '') => {
        for (const name of readdirSync(path)) {
          const full = join(path, name);
          const rel = relative ? `${relative}/${name}` : name;
          if (statSync(full).isDirectory()) visit(full, rel);
          else
            result[rel] = {
              bytes: readFileSync(full).toString('base64'),
              mode: statSync(full).mode & 0o7777,
            };
        }
      };
      visit(directory);
      return result;
    };
    expect(files(workspaces[0])).toEqual(files(workspaces[1]));
    for (const workspace of workspaces) {
      expect(execFileSync('git', ['-C', workspace, 'ls-files'], { encoding: 'utf8' })).toBe(
        '.gitignore\nCLAUDE.md\nREADME.md\n',
      );
      expect(
        execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }),
      ).toBe('');
      expect(
        execFileSync('git', ['-C', workspace, 'symbolic-ref', '--short', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe('main');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('archives committed attributes without personal or global attribute overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-seed-archive-'));
  try {
    const script = readFileSync(
      resolve('docs/spikes/openshell-codex/prepare-mgmt-knowledge.sh'),
      'utf8',
    );
    const archiveStage = script.slice(
      script.indexOf('safe_path() {'),
      script.indexOf('\n# A tracked symlink could'),
    );
    const source = join(root, 'source');
    const workspace = join(root, 'mgmt');
    mkdirSync(source);
    mkdirSync(workspace);
    execFileSync('git', ['init', '-q', source]);
    writeFileSync(join(source, 'README.md'), 'revision $Format:%H$\n');
    writeFileSync(join(source, 'AGENTS.md'), 'Committed exclusion\n');
    writeFileSync(
      join(source, '.gitattributes'),
      'README.md export-subst\nAGENTS.md export-ignore\n',
    );
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=Source',
      '-c',
      'user.email=source@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'source',
    ]);
    const starting = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(source, '.git/info/attributes'),
      'README.md export-ignore\nAGENTS.md -export-ignore\n',
    );
    const globalAttributes = join(root, 'host-attributes');
    writeFileSync(globalAttributes, 'README.md export-ignore\nAGENTS.md -export-ignore\n');
    const hostConfig = join(root, 'host-config');
    mkdirSync(join(hostConfig, 'git'), { recursive: true });
    writeFileSync(
      join(hostConfig, 'git/attributes'),
      'README.md export-ignore\nAGENTS.md -export-ignore\n',
    );
    execFileSync('bash', ['-euc', archiveStage], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: hostConfig,
        source_repo: source,
        starting_commit: starting,
        workspace,
        build_root: root,
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.attributesFile',
        GIT_CONFIG_VALUE_0: globalAttributes,
      },
    });
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe(`revision ${starting}\n`);
    expect(readdirSync(workspace)).toEqual(['README.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
