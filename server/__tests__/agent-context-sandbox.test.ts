import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentLibraryVersion, AgentContextRecipe } from '@mitzo/protocol';
import {
  OpenShellRuntimeManager,
  sandboxNameForConversation,
  openShellRuntimeConfig,
} from '../openshell-runtime.js';
import {
  resolveSandboxAgentContext,
  SANDBOX_AGENT_COMPILER_REVISION,
  sandboxAgentCompilerHash,
} from '../agent-context-sandbox.js';
import { contextDigest } from '../agent-context-compiler.js';

afterEach(() => vi.restoreAllMocks());
const conversationId = 'sandbox-bob';
const runtime = {
  sandboxName: sandboxNameForConversation(conversationId),
  sandboxId: 'physical-sandbox',
  workdir: '/sandbox/workspaces/task',
  appServerCommand: '/sandbox/run-mitzo-app-server' as const,
  cli: 'openshell',
  gateway: 'default',
  workspace: 'default',
  gatewayInsecure: false,
};
const workspaceRecipe: Extract<AgentContextRecipe, { source: 'workspace' }> = {
  version: 1,
  source: 'workspace',
  files: ['design.md'],
  tokenBudget: 1000,
  required: [],
  excluded: [],
};
function profile(recipe: AgentContextRecipe = workspaceRecipe): AgentLibraryVersion {
  const definition = {
    role: 'agent',
    name: 'Bob',
    descriptor: 'The architect',
    instructions: 'Challenge assumptions.',
    expectedOutput: 'Design brief',
    acceptanceCriteria: ['Preserve history'],
    contextRecipe: recipe,
  };
  return {
    profileId: 'bob',
    revision: 3,
    contentHash: contextDigest(definition),
    definition,
  } as AgentLibraryVersion;
}
const contract = {
  knowledgeCompilerCommit: '683f9007db686e710ed9a5410468fe33df1c5382',
  knowledgeSchemaVersion: 1,
  knowledgeCompilerSha256: 'b'.repeat(64),
  knowledgeRecipeSha256: 'c'.repeat(64),
  runtimeInputsSha256: 'd'.repeat(64),
  targetPlatform: 'linux/arm64',
  targetMarkerEnvironmentB64: 'fixture',
  digest: 'sha256:' + 'e'.repeat(64),
};
function fixture() {
  let ready = true;
  let attestation = { ...contract, agentContextCompilerSha256: sandboxAgentCompilerHash() };
  const run = vi.fn(async () =>
    JSON.stringify({
      id: runtime.sandboxId,
      name: runtime.sandboxName,
      phase: ready ? 'Ready' : 'Stopped',
      labels: {
        'mitzo.conversation': createHash('sha256')
          .update(conversationId)
          .digest('hex')
          .slice(0, 63),
        'mitzo.account_provider': 'openai-work',
      },
    }),
  );
  const context = {
    type: 'boot_context',
    source: 'contexgin',
    sourceCount: 1,
    tokenCount: 10,
    tokenBudget: 1000,
    sources: [{ path: 'design.md', kind: 'markdown' }],
    included: [],
    trimmed: [],
    fullMarkdown: 'FULL SAVED RECIPE CONTEXT',
  };
  const runSsh = vi.fn(async (args: readonly string[]) =>
    args.join(' ').includes('attest-knowledge-runtime.py')
      ? JSON.stringify(attestation)
      : JSON.stringify({
          compilerRevision: SANDBOX_AGENT_COMPILER_REVISION,
          workspaceIdentity: contextDigest(runtime.workdir),
          context,
        }),
  );
  const manager = new OpenShellRuntimeManager(
    {
      cli: 'openshell',
      image: 'fixture',
      policy: '/fixture/policy',
      seed: '/fixture/seed',
      seedStackManifest: { runtime: contract },
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'default',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: runtime.workdir,
      webSearch: 'disabled',
      account: { kind: 'api', provider: 'openai-work', model: 'luna-fixture' },
    },
    run,
    undefined,
    runSsh,
  );
  return {
    manager,
    run,
    runSsh,
    context,
    stop: () => {
      ready = false;
    },
    drift: () => {
      attestation = { ...attestation, agentContextCompilerSha256: 'f'.repeat(64) };
    },
  };
}
it('binds the profile recipe to the owning sandbox and resumes without recompiling live files', async () => {
  const f = fixture();
  const input = {
    profile: profile(),
    conversationId,
    runtime,
    manager: f.manager,
    signal: new AbortController().signal,
  };
  const snapshot = await resolveSandboxAgentContext(input);
  expect(snapshot?.sandbox).toMatchObject({
    sandboxId: runtime.sandboxId,
    workspaceRoot: runtime.workdir,
    effectiveRecipeHash: contextDigest(workspaceRecipe),
  });
  expect(snapshot?.payloadHash).toBe(contextDigest(f.context));
  const compiles = () =>
    f.runSsh.mock.calls.filter(([args]) => args.join(' ').includes('compile-agent-context.mjs'));
  expect(compiles()).toHaveLength(1);
  expect(compiles()[0][0].join(' ')).not.toContain('design.md'); // structured base64 argv, no shell interpolation
  expect(await resolveSandboxAgentContext({ ...input, stored: snapshot })).toEqual(snapshot);
  expect(compiles()).toHaveLength(1);
  await expect(
    resolveSandboxAgentContext({ ...input, stored: { ...snapshot!, payloadHash: '0'.repeat(64) } }),
  ).rejects.toThrow(/payload/i);
  await expect(
    resolveSandboxAgentContext({
      ...input,
      stored: snapshot,
      runtime: { ...runtime, workdir: '/sandbox/workspaces/other' },
    }),
  ).rejects.toThrow(/workspace|scope/i);
  await expect(
    resolveSandboxAgentContext({
      ...input,
      stored: snapshot,
      profile: { ...input.profile, revision: 4 },
    }),
  ).rejects.toThrow(/profile/i);
});
it.each(['compiler', 'owner phase', 'during compilation', 'abort'])(
  'refuses unsafe sandbox admission: %s',
  async (failure) => {
    const f = fixture();
    const controller = new AbortController();
    if (failure === 'compiler') f.drift();
    if (failure === 'owner phase') f.stop();
    if (failure === 'abort') controller.abort();
    if (failure === 'during compilation') {
      const original = f.runSsh.getMockImplementation()!;
      f.runSsh.mockImplementation(async (...args) => {
        const output = await original(...args);
        if (args[0].join(' ').includes('compile-agent-context.mjs')) f.stop();
        return output;
      });
    }
    await expect(
      resolveSandboxAgentContext({
        profile: profile(),
        conversationId,
        runtime,
        manager: f.manager,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  },
);
it('resolves a host-configured preset only into bounded sandbox workspace references', async () => {
  const f = fixture();
  const input = {
    profile: profile({ version: 1, source: 'contexgin', agentName: 'architect' }),
    conversationId,
    runtime,
    manager: f.manager,
    signal: new AbortController().signal,
  };
  await expect(resolveSandboxAgentContext(input)).rejects.toThrow(/preset.*configured/i);
  const snapshot = await resolveSandboxAgentContext({
    ...input,
    presets: { architect: workspaceRecipe },
  });
  expect(snapshot?.source).toBe('contexgin');
  expect(snapshot?.sandbox?.effectiveRecipeHash).toBe(contextDigest(workspaceRecipe));
  expect(snapshot?.workspaceIdentity).toBeUndefined();
  await expect(
    resolveSandboxAgentContext({
      ...input,
      presets: { architect: { ...workspaceRecipe, tokenBudget: 2000 } },
      stored: snapshot,
    }),
  ).rejects.toThrow(/recipe|preset/i);
});
it('validates host preset configuration before runtime admission and rejects non-workspace grants', () => {
  const env = {
    MITZO_OPENSHELL_ENABLED: '1',
    MITZO_OPENSHELL_IMAGE: 'fixture',
    MITZO_OPENSHELL_POLICY: '/policy',
    MITZO_OPENSHELL_SEED: '/seed',
    MITZO_OPENSHELL_AGENT_CONTEXT_PRESETS: JSON.stringify({ architect: workspaceRecipe }),
  };
  expect(openShellRuntimeConfig(env)?.agentContextPresets).toEqual({ architect: workspaceRecipe });
  expect(() =>
    openShellRuntimeConfig({
      ...env,
      MITZO_OPENSHELL_AGENT_CONTEXT_PRESETS: JSON.stringify({
        architect: { ...workspaceRecipe, grants: ['github'] },
      }),
    }),
  ).toThrow();
});
