import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  hasExactGlobalSetting,
  loadProductionConfig,
  validateStaticConfig,
  verifyAccountBindings,
  verifyOpenAiHeaderAuthentication,
  verifyPreparedSeed,
} from '../../scripts/verify-openshell-production.mjs';

const manifest = {
  runtime: { image: 'localhost/mitzo:release-1' },
  defaults: { workspace: 'default', webSearch: 'live' },
  serviceProviders: [{ name: 'google-workspace' }, { name: 'github' }],
  providerPolicy: { automatic: ['github'], grantable: ['google-workspace'] },
};

const config = {
  MITZO_OPENSHELL_ENABLED: '1',
  MITZO_OPENSHELL_IMAGE: 'localhost/mitzo:release-1',
  MITZO_OPENSHELL_SERVICE_PROVIDERS: 'github',
  MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS: 'google-workspace',
  MITZO_OPENSHELL_WEB_SEARCH: 'live',
  OPENSHELL_WORKSPACE: 'default',
};

describe('OpenShell production bundle validation', () => {
  const headerProfile = {
    credentials: [
      { env_vars: ['OPENAI_API_KEY'], auth_style: 'bearer', header_name: 'authorization' },
    ],
    endpoints: [
      {
        host: 'api.openai.com',
        port: 443,
        protocol: 'rest',
        enforcement: 'enforce',
        request_body_credential_rewrite: false,
        allow_uninspected_credentials: false,
      },
    ],
  };

  it('accepts inspected OpenAI header authentication without body substitution', () => {
    expect(() => verifyOpenAiHeaderAuthentication(headerProfile)).not.toThrow();
  });

  it.each(['request_body_credential_rewrite', 'allow_uninspected_credentials'])(
    'rejects live OpenAI profile drift enabling %s',
    (flag) => {
      const profile = {
        ...headerProfile,
        endpoints: [{ ...headerProfile.endpoints[0], [flag]: true }],
      };
      expect(() => verifyOpenAiHeaderAuthentication(profile)).toThrow(/OpenAI/);
    },
  );

  it('keeps the checked-in policy and provider profile explicitly inspected', () => {
    const policy = load(
      readFileSync(
        new URL(
          '../../docs/spikes/openshell-codex/openshell-openai-api-policy.yaml',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      network_policies: { openai_api: { endpoints: Array<Record<string, unknown>> } };
    };
    const profile = load(
      readFileSync(
        new URL(
          '../../docs/spikes/openshell-codex/openai-keychain-spike-profile.yaml',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;

    expect(policy.network_policies.openai_api.endpoints[0]).toMatchObject({
      request_body_credential_rewrite: false,
      allow_uninspected_credentials: false,
    });
    expect(() => verifyOpenAiHeaderAuthentication(profile)).not.toThrow();
  });

  it('accepts omitted false-default flags from the gateway protobuf export', () => {
    const endpoint: Record<string, unknown> = { ...headerProfile.endpoints[0] };
    delete endpoint.request_body_credential_rewrite;
    delete endpoint.allow_uninspected_credentials;
    expect(() =>
      verifyOpenAiHeaderAuthentication({ ...headerProfile, endpoints: [endpoint] }),
    ).not.toThrow();
  });

  it.each(['request_body_credential_rewrite', 'allow_uninspected_credentials'])(
    'rejects live OpenAI profile drift enabling %s',
    (flag) => {
      const endpoint: Record<string, unknown> = { ...headerProfile.endpoints[0], [flag]: true };
      expect(() =>
        verifyOpenAiHeaderAuthentication({ ...headerProfile, endpoints: [endpoint] }),
      ).toThrow(/OpenAI/);
    },
  );

  it('rejects missing bearer-header metadata and non-inspected endpoints', () => {
    expect(() => verifyOpenAiHeaderAuthentication({ ...headerProfile, credentials: [] })).toThrow(
      /OpenAI/,
    );
    expect(() => verifyOpenAiHeaderAuthentication({ ...headerProfile, endpoints: [] })).toThrow(
      /OpenAI/,
    );
    expect(() =>
      verifyOpenAiHeaderAuthentication({
        ...headerProfile,
        endpoints: [{ ...headerProfile.endpoints[0], protocol: 'tcp' }],
      }),
    ).toThrow(/OpenAI/);
  });

  it('matches only active global settings with exact values', () => {
    expect(hasExactGlobalSetting('providers_v2_enabled = true', 'providers_v2_enabled', true)).toBe(
      true,
    );
    expect(
      hasExactGlobalSetting('# providers_v2_enabled = true', 'providers_v2_enabled', true),
    ).toBe(false);
    expect(
      hasExactGlobalSetting('providers_v2_enabled = trueish', 'providers_v2_enabled', true),
    ).toBe(false);
    expect(
      hasExactGlobalSetting(
        '# providers_v2_enabled = true\nproviders_v2_enabled = false',
        'providers_v2_enabled',
        true,
      ),
    ).toBe(false);
  });

  it('makes the release env authoritative over inherited deploy variables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mitzo-release-env-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'MITZO_OPENSHELL_IMAGE=release-image\n');

    expect(
      loadProductionConfig(envPath, { MITZO_OPENSHELL_IMAGE: 'stale-shell-image' })
        .MITZO_OPENSHELL_IMAGE,
    ).toBe('release-image');
  });

  it('accepts only a prepared seed matching the enabled stack lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-enabled-seed-'));
    const seed = join(root, 'mgmt');
    mkdirSync(seed);
    writeFileSync(join(root, 'baseline.json'), '{"startingCommit":"mgmt-commit"}\n');

    expect(config.MITZO_OPENSHELL_ENABLED).toBe('1');
    expect(() => verifyPreparedSeed(seed, 'mgmt-commit')).not.toThrow();
    expect(() => verifyPreparedSeed(seed, 'different-commit')).toThrow(
      'prepared seed commit does not match the stack lock',
    );
  });

  it('accepts a pinned image and exact provider ordering', () => {
    expect(validateStaticConfig(config, manifest)).toEqual({
      enabled: true,
      image: 'localhost/mitzo:release-1',
      configuredProviders: ['github'],
      grantableProviders: ['google-workspace'],
    });
  });

  it('rejects overlapping automatic and grantable provider policies', () => {
    const overlapping = {
      ...manifest,
      providerPolicy: { automatic: ['github'], grantable: ['github'] },
    };
    expect(() =>
      validateStaticConfig(
        {
          ...config,
          MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS: 'github',
        },
        overlapping,
      ),
    ).toThrow('overlap');
  });

  it('pins the production service-provider contract for GWS and GitHub CLI', () => {
    const lock = JSON.parse(
      readFileSync(
        new URL('../../infra/openshell/production-stack.lock.json', import.meta.url),
        'utf8',
      ),
    );
    expect(lock.runtime.requiredBinaries).toEqual([
      '/usr/bin/codex',
      '/usr/bin/gws',
      '/usr/bin/gh',
    ]);
    expect(lock.serviceProviders).toEqual([
      {
        name: 'google-workspace',
        type: 'mitzo-google-workspace-spike',
        credentialKeys: ['GOOGLE_WORKSPACE_CLI_TOKEN'],
      },
      { name: 'github', type: 'github', credentialKeys: ['GITHUB_TOKEN'] },
    ]);
    expect(lock.providerPolicy).toEqual({
      automatic: ['github'],
      grantable: ['google-workspace'],
    });
  });

  it.each(['localhost/mitzo', 'localhost/mitzo:latest', 'localhost/mitzo:dev'])(
    'rejects mutable image reference %s',
    (image) => {
      expect(() =>
        validateStaticConfig({ ...config, MITZO_OPENSHELL_IMAGE: image }, manifest),
      ).toThrow();
    },
  );

  it('requires brokered subscription fields to match the gateway provider', () => {
    const provider = { name: 'personal-chatgpt', id: 'provider-1' };
    const account = {
      id: 'personal',
      provider: 'openai-codex',
      sandboxProvider: provider.name,
      sandboxProviderType: 'openai-codex-oauth',
      sandboxProviderId: provider.id,
      sandboxGrantId: 'grant-1',
    };
    expect(() => verifyAccountBindings([account], [provider])).not.toThrow();
    expect(() =>
      verifyAccountBindings([{ ...account, credentialRef: '/host/login' }], [provider]),
    ).toThrow(/mixes host/);
    expect(() =>
      verifyAccountBindings([{ ...account, sandboxGrantId: undefined }], [provider]),
    ).toThrow(/incomplete/);
  });

  it('keeps the OpenAI API-key profile on REST without a conflicting websocket endpoint', () => {
    const profile = readFileSync(
      new URL(
        '../../docs/spikes/openshell-codex/openai-keychain-spike-profile.yaml',
        import.meta.url,
      ),
      'utf8',
    );
    expect(profile).toContain('protocol: rest');
    expect(profile).not.toContain('protocol: websocket');
  });

  it('keeps sandbox-native Google Workspace reads within the requested data services', () => {
    const profile = readFileSync(
      new URL(
        '../../docs/spikes/openshell-codex/google-workspace-spike-profile.yaml',
        import.meta.url,
      ),
      'utf8',
    );
    for (const scope of [
      'drive.readonly',
      'documents.readonly',
      'calendar.readonly',
      'gmail.readonly',
      'spreadsheets.readonly',
    ])
      expect(profile).toContain(scope);
    for (const host of [
      'www.googleapis.com',
      'docs.googleapis.com',
      'gmail.googleapis.com',
      'sheets.googleapis.com',
    ])
      expect(profile).toContain(`host: ${host}`);
    expect(profile).not.toContain('access: read-write');
  });

  it('starts the Podman machine before OpenShell production preflight', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy.sh', import.meta.url), 'utf8');
    const readiness = deploy.indexOf("podman machine inspect --format '{{.State}}'");
    const preflight = deploy.indexOf('node scripts/verify-openshell-production.mjs');
    expect(readiness).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(readiness);
  });

  it('keeps release creation serialized, remote-complete, and atomic', () => {
    const release = readFileSync(
      new URL('../../scripts/create-release.sh', import.meta.url),
      'utf8',
    );
    expect(release).toContain('+refs/heads/*:refs/remotes/origin/*');
    expect(release).toContain("awk 'NF == 1 { print $1; exit }'");
    expect(release).toContain('canonical runtime .env is missing');
    expect(release).toContain('MITZO_RELEASE_SEED is not a directory');
    expect(release).toContain('MITZO_RELEASE_SEED has no sibling baseline.json');
    expect(release).toContain('rewrite_env_value MITZO_OPENSHELL_SEED "$RELEASE_SEED"');
    expect(release).toContain('shlock -f "$LOCK_FILE" -p "$$"');
    expect(release).toContain('LOCK_FILE="/tmp/com.mitzo.server.$(id -u).deploy.lock"');
    expect(release).not.toContain('LOCK_FILE="$RELEASE_ROOT');
    expect(release).toContain('mktemp -d "$RELEASE_ROOT/.build.XXXXXX"');
    expect(release).toContain(
      'MITZO_OPENSHELL_STACK_MANIFEST "$FINAL_RELEASE_DIR/infra/openshell/production-stack.lock.json"',
    );
    expect(release.indexOf('node scripts/verify-openshell-production.mjs .env')).toBeLessThan(
      release.indexOf(
        'MITZO_OPENSHELL_STACK_MANIFEST "$FINAL_RELEASE_DIR/infra/openshell/production-stack.lock.json"',
      ),
    );
    expect(release.indexOf('mv "$RELEASE_DIR" "$FINAL_RELEASE_DIR"')).toBeGreaterThan(
      release.indexOf('node scripts/verify-openshell-production.mjs .env'),
    );
    const guard = readFileSync(
      new URL('../../scripts/assert-deployable.sh', import.meta.url),
      'utf8',
    );
    expect(guard).toContain('fetch --prune "$DEPLOY_REMOTE"');
    expect(guard).toContain('"refs/remotes/$DEPLOY_REMOTE"');
  });

  it('refreshes publication and main ancestry before accepting a release', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-deploy-guard-'));
    const remote = join(root, 'origin.git');
    const source = join(root, 'source');
    const release = join(root, 'release');
    const repoRoot = new URL('../..', import.meta.url).pathname;

    execFileSync('git', ['init', '--bare', remote]);
    execFileSync('git', ['clone', '--no-local', repoRoot, source]);
    execFileSync('git', ['-C', source, 'remote', 'set-url', 'origin', remote]);
    execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Test']);
    cpSync(
      join(repoRoot, 'scripts/assert-deployable.sh'),
      join(source, 'scripts/assert-deployable.sh'),
    );
    execFileSync('git', ['-C', source, 'add', 'scripts/assert-deployable.sh']);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'deploy guard fixture',
    ]);
    execFileSync('git', ['-C', source, 'push', 'origin', 'HEAD:refs/heads/main']);
    const main = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'published feature',
    ]);
    const feature = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', source, 'push', 'origin', 'HEAD:refs/heads/review-fixture']);
    execFileSync('git', ['clone', '--no-local', remote, release]);
    execFileSync('git', ['-C', release, 'checkout', '--detach', feature]);
    const tree = execFileSync('git', ['-C', release, 'rev-parse', 'HEAD^{tree}'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(release, 'release.txt'),
      `source_commit=${feature}\nbase_main=${main}\nsource_tree=${tree}\n`,
    );

    let result = spawnSync('bash', [join(release, 'scripts/assert-deployable.sh')], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);

    execFileSync('git', ['-C', source, 'push', 'origin', '--delete', 'review-fixture']);
    result = spawnSync('bash', [join(release, 'scripts/assert-deployable.sh')], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not published on a remote branch');

    execFileSync('git', ['-C', source, 'push', 'origin', `${feature}:refs/heads/review-fixture`]);
    execFileSync('git', ['-C', source, 'checkout', '--detach', main]);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'new main',
    ]);
    execFileSync('git', ['-C', source, 'push', 'origin', 'HEAD:refs/heads/main']);
    result = spawnSync('bash', [join(release, 'scripts/assert-deployable.sh')], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not contain current origin/main');
  }, 15_000);

  it('retains the published feature ref when releasing from a detached checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-detached-release-'));
    const remote = join(root, 'origin.git');
    const source = join(root, 'source');
    const releases = join(root, 'releases');
    const bin = join(root, 'bin');
    const marker = join(root, 'publication-verified');
    const preparedSeed = join(root, 'prepared-seed');
    const seed = join(preparedSeed, 'mgmt');
    const accounts = join(root, 'accounts.json');
    const repoRoot = new URL('../..', import.meta.url).pathname;
    const stack = JSON.parse(
      readFileSync(join(repoRoot, 'infra/openshell/production-stack.lock.json'), 'utf8'),
    );

    execFileSync('git', ['init', '--bare', remote]);
    execFileSync('git', ['clone', '--no-local', repoRoot, source]);
    execFileSync('git', ['-C', source, 'remote', 'set-url', 'origin', remote]);
    execFileSync('git', ['-C', source, 'push', 'origin', 'HEAD:refs/heads/main']);
    execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    execFileSync('git', ['-C', source, 'remote', 'set-head', 'origin', '-a']);
    const mainRevision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Test']);
    writeFileSync(join(source, 'scripts/deploy.sh'), '#!/bin/sh\nexit 73\n');
    chmodSync(join(source, 'scripts/deploy.sh'), 0o755);
    execFileSync('git', ['-C', source, 'add', 'scripts/deploy.sh']);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'fixture feature',
    ]);
    execFileSync('git', ['-C', source, 'push', 'origin', 'HEAD:refs/heads/review-fixture']);
    const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', source, 'checkout', '--detach', revision]);
    mkdirSync(seed, { recursive: true });
    writeFileSync(
      join(preparedSeed, 'baseline.json'),
      `${JSON.stringify({ startingCommit: stack.runtime.mgmtSourceCommit })}\n`,
    );
    writeFileSync(accounts, '[]\n');
    mkdirSync(bin);
    const openshell = join(bin, 'openshell');
    const podman = join(bin, 'podman');
    writeFileSync(
      join(source, '.env'),
      [
        'MITZO_OPENSHELL_ENABLED=1',
        'MITZO_OPENSHELL_SEED=/unchanged/canonical/seed',
        `MITZO_ACCOUNT_PROFILES_FILE=${accounts}`,
        `MITZO_OPENSHELL_CLI=${openshell}`,
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(bin, 'shlock'),
      '#!/bin/sh\nlock=""\nwhile [ "$#" -gt 0 ]; do case "$1" in -f) lock="$2"; shift 2;; *) shift;; esac; done\n( set -C; : > "$lock" ) 2>/dev/null || exit 1\n',
    );
    writeFileSync(
      join(bin, 'npm'),
      '#!/bin/sh\nref="refs/remotes/origin/$EXPECTED_BRANCH"\ngit show-ref --verify "$ref" >/dev/null || exit 71\ngit merge-base --is-ancestor "$EXPECTED_REVISION" "$ref" || exit 72\nif [ -n "${EXPECTED_SEED-}" ]; then grep -Fx "MITZO_OPENSHELL_SEED=$EXPECTED_SEED" .env >/dev/null || exit 74; fi\nprintf ok > "$MARKER"\nif [ "${VERIFY_RELEASE-}" = 1 ]; then ln -s "$TEST_NODE_MODULES" node_modules; exit 0; fi\nexit 73\n',
    );
    writeFileSync(
      openshell,
      '#!/bin/sh\ncase "$*" in\n  "gateway info -o json") printf \'{"version":"%s","compute_drivers":[{"name":"podman","capabilities":{"driver_version":"%s"}}]}\\n\' "$EXPECTED_GATEWAY" "$EXPECTED_DRIVER" ;;\n  "settings get --global") printf \'providers_v2_enabled = true\\n\' ;;\n  "provider list -o json") printf \'[{"name":"google-workspace","type":"mitzo-google-workspace-spike","credential_keys":["GOOGLE_WORKSPACE_CLI_TOKEN"]},{"name":"github","type":"github","credential_keys":["GITHUB_TOKEN"]}]\\n\' ;;\n  *) exit 75 ;;\nesac\n',
    );
    writeFileSync(
      podman,
      '#!/bin/sh\nif [ "$1" = run ]; then exit 0; fi\n[ "$1 $2" = "image inspect" ] || exit 76\ncase "$3|$5" in\n  "$EXPECTED_IMAGE|{{.Digest}}") printf \'%s\\n\' "$EXPECTED_IMAGE_DIGEST" ;;\n  "$EXPECTED_IMAGE|{{json .Labels}}") printf \'{"io.mitzo.source-commit":"%s","io.mitzo.mgmt-source-commit":"%s","io.mitzo.openshell.base-image":"%s"}\\n\' "$EXPECTED_MITZO_COMMIT" "$EXPECTED_MGMT_COMMIT" "$EXPECTED_BASE_IMAGE" ;;\n  "$EXPECTED_SUPERVISOR|{{.Digest}}"|"localhost/openshell/supervisor:dev|{{.Digest}}") printf \'%s\\n\' "$EXPECTED_SUPERVISOR_DIGEST" ;;\n  "$EXPECTED_SUPERVISOR|{{ index .Labels \\"org.opencontainers.image.revision\\" }}") printf \'%s\\n\' "$EXPECTED_SUPERVISOR_COMMIT" ;;\n  *) exit 77 ;;\nesac\n',
    );
    chmodSync(join(bin, 'shlock'), 0o755);
    chmodSync(join(bin, 'npm'), 0o755);
    chmodSync(openshell, 0o755);
    chmodSync(podman, 0o755);

    const verificationEnv = {
      VERIFY_RELEASE: '1',
      TEST_NODE_MODULES: join(repoRoot, 'node_modules'),
      PODMAN: podman,
      EXPECTED_GATEWAY: stack.gateway.version,
      EXPECTED_DRIVER: stack.gateway.driverVersion,
      EXPECTED_IMAGE: stack.runtime.image,
      EXPECTED_IMAGE_DIGEST: stack.runtime.digest,
      EXPECTED_MITZO_COMMIT: stack.runtime.mitzoSourceCommit,
      EXPECTED_MGMT_COMMIT: stack.runtime.mgmtSourceCommit,
      EXPECTED_BASE_IMAGE: stack.runtime.baseImage,
      EXPECTED_SUPERVISOR: stack.supervisor.image,
      EXPECTED_SUPERVISOR_DIGEST: stack.supervisor.digest,
      EXPECTED_SUPERVISOR_COMMIT: stack.supervisor.sourceCommit,
    };

    const result = spawnSync('bash', [join(repoRoot, 'scripts/create-release.sh'), revision], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MITZO_SOURCE_ROOT: source,
        MITZO_RUNTIME_ROOT: source,
        MITZO_RELEASE_ROOT: releases,
        EXPECTED_REVISION: revision,
        EXPECTED_BRANCH: 'review-fixture',
        EXPECTED_SEED: realpathSync(seed),
        MARKER: marker,
        MITZO_RELEASE_SEED: seed,
        ...verificationEnv,
      },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(73);
    expect(readFileSync(marker, 'utf8')).toBe('ok');
    expect(readFileSync(join(source, '.env'), 'utf8')).toContain(
      'MITZO_OPENSHELL_SEED=/unchanged/canonical/seed',
    );

    writeFileSync(join(preparedSeed, 'baseline.json'), '{"startingCommit":"drifted"}\n');
    const mismatchResult = spawnSync(
      'bash',
      [join(repoRoot, 'scripts/create-release.sh'), revision],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MITZO_SOURCE_ROOT: source,
          MITZO_RUNTIME_ROOT: source,
          MITZO_RELEASE_ROOT: join(root, 'mismatch-releases'),
          EXPECTED_REVISION: revision,
          EXPECTED_BRANCH: 'review-fixture',
          EXPECTED_SEED: realpathSync(seed),
          MARKER: join(root, 'mismatch-publication-verified'),
          MITZO_RELEASE_SEED: seed,
          ...verificationEnv,
        },
        encoding: 'utf8',
      },
    );
    expect(mismatchResult.status).not.toBe(0);
    expect(mismatchResult.stderr).toContain('prepared seed commit does not match the stack lock');

    const mainMarker = join(root, 'main-publication-verified');
    const mainResult = spawnSync(
      'bash',
      [join(repoRoot, 'scripts/create-release.sh'), mainRevision],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MITZO_SOURCE_ROOT: source,
          MITZO_RUNTIME_ROOT: source,
          MITZO_RELEASE_ROOT: releases,
          EXPECTED_REVISION: mainRevision,
          EXPECTED_BRANCH: 'main',
          MARKER: mainMarker,
        },
        encoding: 'utf8',
      },
    );
    expect(mainResult.status, mainResult.stderr).toBe(73);
    expect(readFileSync(mainMarker, 'utf8')).toBe('ok');
  }, 15_000);
});
