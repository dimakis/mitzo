import { describe, expect, it } from 'vitest';
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
  it('compiles real native profiles with immutable credential denies and dynamic workspace roots', () => {
    const policy = codexNativeExecutionPolicy(input);
    expect(policy).toMatchObject({
      version: 'native-mac-permissions-v1',
      bindingRevision: input.bindingRevision,
      enforcement: 'configured',
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
          },
          network: { enabled: false },
        },
        'mitzo-native-agent': {
          filesystem: {
            '/': 'read',
            ':workspace_roots': 'write',
            '/operator/runtime': 'read',
            '/private/provider-auth': 'deny',
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
      'features.apps': false,
      'features.multi_agent': false,
    });
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
