import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexNativeExecutionPolicy,
  codexNativePermissionProfiles,
  assertNativeExecutionRefresh,
} from '../codex-native-execution-policy.js';
import { codexThreadOptions, codexTurnStartParams } from '../codex-ordinary-packet.js';
import { codexRuntimeOverrides } from '../codex-runtime-policy.js';

const input = {
  bindingRevision: 'selected-account-and-permission-v1',
  mode: 'agent' as const,
  cwd: '/workspace/one',
  readableRoots: ['/'],
  writableRoots: ['/workspace/one'],
  deniedRoots: ['/private/provider-auth'],
  writeProtectedRoots: ['/operator/runtime'],
};

describe('native Mac execution permission profile', () => {
  it('rejects generic read exceptions within a credential deny, including canonical aliases', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mitzo-policy-alias-'));
    try {
      const denied = join(temporary, 'credentials');
      const nested = join(denied, 'nested');
      mkdirSync(nested, { recursive: true });
      const alias = join(temporary, 'alias');
      symlinkSync(nested, alias);
      for (const path of [denied, nested, alias]) {
        expect(() =>
          codexNativeExecutionPolicy({
            ...input,
            deniedRoots: [denied],
            readableRoots: ['/', path],
          }),
        ).toThrow('Native read scope exposes protected storage');
        expect(() =>
          codexNativeExecutionPolicy({
            ...input,
            deniedRoots: [denied],
            writeProtectedRoots: [path],
          }),
        ).toThrow('Native read scope exposes protected storage');
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  it.each(['readableRoots', 'writeProtectedRoots'] as const)(
    'refuses literal positive-map metacharacters in %s rather than widening their parent',
    (field) => {
      const root = mkdtempSync(join(tmpdir(), 'mitzo-native-literal-'));
      try {
        const literal = join(root, '**');
        mkdirSync(literal);
        const alias = join(root, 'alias');
        symlinkSync(literal, alias);
        for (const path of [literal, alias]) {
          expect(() =>
            codexNativeExecutionPolicy({
              ...input,
              [field]: [path],
            }),
          ).toThrow('Native positive filesystem path requires unsupported literal encoding');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('retains literal workspace paths through the special runtime roots array', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-native-workspace-literal-'));
    try {
      const workspace = join(root, '**');
      mkdirSync(workspace);
      const policy = codexNativeExecutionPolicy({
        ...input,
        cwd: workspace,
        writableRoots: [workspace],
      });
      expect(policy.workspaceRoots).toEqual([realpathSync(workspace)]);
      const native = codexThreadOptions({
        model: 'fixture',
        modelProvider: 'openai',
        cwd: '/old',
        runtimeConfig: {},
        webSearch: 'disabled',
        systemPrompt: '',
        nativeExecution: policy,
      });
      if (!('runtimeWorkspaceRoots' in native)) throw Error('Expected native execution options');
      expect(native.runtimeWorkspaceRoots).toEqual([realpathSync(workspace)]);
      expect(
        codexNativePermissionProfiles(policy).permissions['mitzo-native-agent'].filesystem,
      ).not.toHaveProperty(workspace);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('preserves a narrower readable ceiling without making outside authority files readable', () => {
    const policy = codexNativeExecutionPolicy({
      ...input,
      readableRoots: ['/workspace/one', '/usr'],
      writeProtectedRoots: ['/operator/runtime', '/usr/trusted'],
    });
    const profiles = codexNativePermissionProfiles(policy).permissions;
    for (const profile of Object.values(profiles)) {
      expect(profile.filesystem).not.toHaveProperty('/operator/runtime');
      expect(profile.filesystem).toMatchObject({
        '/workspace/one': 'read',
        '/usr': 'read',
        '/usr/trusted': 'read',
      });
    }
    expect(policy.writeProtectedRoots).toContain('/operator/runtime');
  });
  it('compiles real native profiles with fixed credential deny globs and dynamic workspace roots', () => {
    const policy = codexNativeExecutionPolicy(input);
    expect(policy).toMatchObject({
      version: 'native-mac-permissions-v1',
      bindingRevision: input.bindingRevision,
      enforcement: 'configured',
      scopeKind: 'base-profile',
      grantState: 'upstream-owned',
      readableRoots: ['/'],
      writableRoots: ['/workspace/one'],
      networkAccess: 'restricted',
      approvalPolicy: 'on-request',
      reviewer: 'user',
    });
    expect(codexNativePermissionProfiles(policy)).toEqual({
      default_permissions: 'mitzo-native-agent',
      permissions: {
        'mitzo-native-ask': {
          filesystem: {
            '/': 'read',
            ':workspace_roots': 'read',
            '/operator/runtime': 'read',
            '/private/provider-auth': 'deny',
            '/private/provider-auth{,/**}': 'deny',
          },
          network: { enabled: false },
        },
        'mitzo-native-agent': {
          filesystem: {
            '/': 'read',
            ':workspace_roots': 'write',
            '/operator/runtime': 'read',
            '/private/provider-auth': 'deny',
            '/private/provider-auth{,/**}': 'deny',
          },
          network: { enabled: false },
        },
      },
    });
    expect(codexRuntimeOverrides({}, undefined, policy)).toMatchObject({
      'features.shell_tool': true,
      'features.unified_exec': true,
      'features.exec_permission_approvals': true,
      'features.request_permissions_tool': true,
      'features.shell_zsh_fork': false,
      'features.apps': false,
      'features.multi_agent': false,
    });
  });

  it('escapes credential path metacharacters before compiling the fixed subtree deny glob', () => {
    const path = '/credential[*]?{literal}\\name';
    const profile = codexNativePermissionProfiles(
      codexNativeExecutionPolicy({ ...input, deniedRoots: [path] }),
    );
    expect(profile.permissions['mitzo-native-agent'].filesystem).toHaveProperty(
      '/credential\\[\\*\\]\\?\\{literal\\}\\\\name{,/**}',
      'deny',
    );
  });

  it('uses named permissions at both native boundaries without a stale sandbox policy', () => {
    const policy = codexNativeExecutionPolicy(input);
    const thread = codexThreadOptions({
      model: 'offline',
      modelProvider: 'openai',
      cwd: '/ignored',
      runtimeConfig: {},
      webSearch: 'disabled',
      systemPrompt: '',
      nativeExecution: policy,
    });
    expect(thread).toMatchObject({
      cwd: policy.cwd,
      permissions: 'mitzo-native-agent',
      runtimeWorkspaceRoots: ['/workspace/one'],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
    expect(thread).not.toHaveProperty('sandbox');
    const turn = codexTurnStartParams({
      threadId: 't',
      commandId: 'c',
      model: 'offline',
      prompt: 'Run',
      additionalContext: {},
      sandboxPolicy: { type: 'readOnly' },
      nativeExecution: policy,
    });
    expect(turn).toMatchObject({
      cwd: policy.cwd,
      permissions: 'mitzo-native-agent',
      runtimeWorkspaceRoots: ['/workspace/one'],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
    expect(turn).not.toHaveProperty('sandboxPolicy');
  });

  it('keeps Ask read-only and makes unavailable automatic review explicit', () => {
    const policy = codexNativeExecutionPolicy({ ...input, mode: 'ask' });
    expect(policy.permissions).toBe('mitzo-native-ask');
    expect(policy.writableRoots).toEqual([]);
    expect(policy.reviewer).toBe('user');
    expect(policy.reviewerAvailability).toBe('unqualified');
  });

  it('preserves a narrower selected read scope rather than inferring root reads from Agent mode', () => {
    const policy = codexNativeExecutionPolicy({
      ...input,
      readableRoots: ['/workspace/one', '/usr'],
    });
    expect(policy.readableRoots).toEqual(['/usr', '/workspace/one']);
    expect(
      codexNativePermissionProfiles(policy).permissions['mitzo-native-agent'].filesystem,
    ).not.toHaveProperty('/');
  });

  it('allows a safe-point workspace transition but rejects changed binding or credential fences', () => {
    const first = codexNativeExecutionPolicy(input);
    const next = codexNativeExecutionPolicy({
      ...input,
      cwd: '/workspace/two',
      writableRoots: ['/workspace/two'],
    });
    expect(() => assertNativeExecutionRefresh(first, next)).not.toThrow();
    expect(next.policyRevision).not.toBe(first.policyRevision);
    for (const changed of [
      { bindingRevision: 'other-account' },
      { deniedRoots: ['/new-auth'] },
      { readableRoots: ['/workspace'] },
      { writeProtectedRoots: [] },
    ])
      expect(() =>
        assertNativeExecutionRefresh(first, codexNativeExecutionPolicy({ ...input, ...changed })),
      ).toThrow('Native execution policy changed');
  });

  it('fails closed for absent credential fences, relative roots and private workspaces', () => {
    for (const changed of [
      { deniedRoots: [] },
      { cwd: 'relative' },
      { writableRoots: ['relative'] },
      { cwd: '/private/provider-auth/task', writableRoots: ['/private/provider-auth/task'] },
      { cwd: '/operator/runtime', writableRoots: ['/operator/runtime'] },
    ])
      expect(() => codexNativeExecutionPolicy({ ...input, ...changed })).toThrow();
  });
});
