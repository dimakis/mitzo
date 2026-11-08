import { describe, expect, it } from 'vitest';
import {
  SessionLaunchConfigSchema,
  StartSessionInputSchema,
  resolveSessionLaunchConfig,
} from '../src/session-launch.js';

describe('saved session launch intent', () => {
  const configuration = {
    version: 1,
    runtime: {
      version: 1,
      account: { accountId: 'subscription', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
      accountReference: {
        accountId: 'subscription',
        provider: 'openai-codex',
        profileRevision: 'r1',
      },
      agentProfile: { kind: 'builtin', profileId: 'default-mitzo', revision: 1 },
      execution: { location: 'local', targetId: 'host-mac' },
    },
    mode: 'agent',
    isolation: true,
    repositoryWorkspaceId: null,
    contextBlocks: ['Project context'],
    extraTools: [],
  };
  it('retains every launch setting, including the exact Local Mac target', () => {
    expect(SessionLaunchConfigSchema.parse(configuration)).toEqual(configuration);
  });
  it('does not treat a saved configuration as capability or permission approval', () => {
    expect(
      SessionLaunchConfigSchema.safeParse({ ...configuration, grantId: 'inherited' }).success,
    ).toBe(false);
    expect(
      SessionLaunchConfigSchema.safeParse({
        ...configuration,
        runtime: { ...configuration.runtime, capabilityRevision: 'stale' },
      }).success,
    ).toBe(false);
  });
  it('allows an agent to propose overrides but never supply operator or child identity', () => {
    const input = {
      requestId: 'da384b7d-7981-4565-8ea9-07b0beb7ddcd',
      title: 'Approval notifications',
      prompt: 'Continue the routing work.',
      overrides: {
        mode: 'ask',
        runtime: { execution: { location: 'local', targetId: 'host-mac' } },
      },
    };
    expect(StartSessionInputSchema.parse(input)).toEqual(input);
    expect(StartSessionInputSchema.safeParse({ ...input, operatorId: 'user' }).success).toBe(false);
  });
  it('lets an agent override only thinking while retaining the saved account and exact host', () => {
    const saved = SessionLaunchConfigSchema.parse(configuration);
    const input = StartSessionInputSchema.parse({
      requestId: 'e37fb730-3b66-4b9a-92c9-3977f2d5d9f1',
      title: 'Quick task',
      prompt: 'Check this',
      overrides: { runtime: { account: { reasoningEffort: 'low' } } },
    });
    const resolved = resolveSessionLaunchConfig(saved, input.overrides);
    expect(resolved.runtime.account).toEqual({ ...saved.runtime.account, reasoningEffort: 'low' });
    expect(resolved.runtime.execution).toEqual(saved.runtime.execution);
    expect(resolved.runtime.accountReference).toEqual(saved.runtime.accountReference);
  });
});
