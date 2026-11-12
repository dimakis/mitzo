import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertClaudeSubscriptionAccount,
  ClaudeSubscriptionCustody,
  ClaudeSubscriptionSignInError,
} from '../claude-subscription-custody.js';

it.each([
  ['Claude Max', 'max'],
  ['Claude Pro', 'pro'],
  ['max', 'max'],
  ['pro', 'pro'],
])('accepts the SDK subscription label %s for the configured %s plan', (subscriptionType, plan) => {
  expect(() =>
    assertClaudeSubscriptionAccount(
      { apiProvider: 'firstParty', email: 'PERSON@example.test', subscriptionType },
      { MITZO_CLAUDE_EXPECTED_EMAIL: 'person@example.test', MITZO_CLAUDE_EXPECTED_PLAN: plan },
    ),
  ).not.toThrow();
});

it.each([
  { subscriptionType: 'Claude Pro' },
  { subscriptionType: 'Claude Team' },
  { subscriptionType: 'Claude API' },
  { subscriptionType: undefined },
  { subscriptionType: 'unknown' },
  { email: 'other@example.test' },
  { email: undefined },
  { apiProvider: 'vertex' as const },
  { apiKeySource: 'ANTHROPIC_API_KEY' },
])('rejects changed or unsupported SDK identity with an identity diagnostic: %j', (change) => {
  expect(() =>
    assertClaudeSubscriptionAccount(
      {
        apiProvider: 'firstParty',
        email: 'person@example.test',
        subscriptionType: 'Claude Max',
        ...change,
      },
      { MITZO_CLAUDE_EXPECTED_EMAIL: 'person@example.test', MITZO_CLAUDE_EXPECTED_PLAN: 'max' },
    ),
  ).toThrow(expect.objectContaining({ reason: 'identity_mismatch' }));
});

it('does not accept missing or unsupported plans even when both sides agree', () => {
  for (const plan of [undefined, 'Claude Team', 'unknown']) {
    expect(() =>
      assertClaudeSubscriptionAccount(
        { apiProvider: 'firstParty', email: 'person@example.test', subscriptionType: plan },
        { MITZO_CLAUDE_EXPECTED_EMAIL: 'person@example.test', MITZO_CLAUDE_EXPECTED_PLAN: plan },
      ),
    ).toThrow();
  }
});

it.each([
  [{ email: 'another-private@example.test' }, ['email']],
  [{ subscriptionType: 'Claude Pro' }, ['plan']],
  [{ apiProvider: 'vertex' as const }, ['provider']],
  [{ apiKeySource: 'private-api-key-source' }, ['billing']],
])(
  'identifies the failed SDK account check without exposing its values: %j',
  (change, mismatches) => {
    try {
      assertClaudeSubscriptionAccount(
        {
          apiProvider: 'firstParty',
          email: 'private@example.test',
          subscriptionType: 'Claude Max',
          ...change,
        },
        { MITZO_CLAUDE_EXPECTED_EMAIL: 'private@example.test', MITZO_CLAUDE_EXPECTED_PLAN: 'max' },
      );
      throw Error('verification unexpectedly succeeded');
    } catch (error) {
      const diagnostic = (error as Error & { telemetry(): object }).telemetry();
      expect(diagnostic).toMatchObject({
        reason: 'identity_mismatch',
        identitySource: 'sdk_account',
        mismatches,
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(/private|example|Claude Max|vertex/);
      expect(JSON.stringify(error)).not.toMatch(/private|example|Claude Max|vertex/);
    }
  },
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(failNativeCommand = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-custody-')));
  roots.push(root);
  const config = join(root, 'personal');
  mkdirSync(config, { mode: 0o700 });
  const executable = join(root, 'claude');
  const status = join(root, 'status.json');
  writeFileSync(
    executable,
    '#!/bin/sh\ncat "' +
      status +
      '"\n' +
      (failNativeCommand ? 'cat "' + status + '" >&2\nexit 1\n' : ''),
    { mode: 0o700 },
  );
  const identity = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'person@example.test',
    subscriptionType: 'max',
  };
  const writeStatus = (value = identity) => writeFileSync(status, JSON.stringify(value));
  writeStatus();
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    CLAUDE_CONFIG_DIR: config,
    MITZO_CLAUDE_EXPECTED_EMAIL: identity.email,
    MITZO_CLAUDE_EXPECTED_PLAN: 'max',
  };
  return { root, config, executable, identity, env, writeStatus };
}
it('verifies the native CLI account without persisting tokens and permits refresh for the same identity', async () => {
  const f = fixture(),
    custody = ClaudeSubscriptionCustody.capture(f.env, f.executable);
  await custody.verify(f.env, new AbortController().signal);
  expect(ClaudeSubscriptionCustody.reopen(custody.snapshot(), f.env).snapshot()).toEqual(
    custody.snapshot(),
  );
  expect(JSON.stringify(custody.snapshot())).not.toMatch(/accessToken|refreshToken/);
  f.writeStatus();
  await custody.verify(f.env, new AbortController().signal);
});
it('distinguishes a native status mismatch from an SDK metadata mismatch', async () => {
  const f = fixture(),
    custody = ClaudeSubscriptionCustody.capture(f.env, f.executable);
  f.writeStatus({ ...f.identity, email: 'other@example.test', subscriptionType: 'pro' });
  try {
    await custody.verify(f.env, new AbortController().signal);
    throw Error('verification unexpectedly succeeded');
  } catch (error) {
    const diagnostic = (error as Error & { telemetry(): object }).telemetry();
    expect(diagnostic).toMatchObject({
      reason: 'identity_mismatch',
      identitySource: 'native_status',
      mismatches: ['email', 'plan'],
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/other@|person@|pro|max/);
  }
});
it('rejects logout, another identity, API billing, contaminated environments and replaced account roots', async () => {
  const f = fixture(),
    custody = ClaudeSubscriptionCustody.capture(f.env, f.executable);
  for (const status of [
    { ...f.identity, loggedIn: false },
    { ...f.identity, email: 'other@example.test' },
    { ...f.identity, authMethod: 'api_key' },
    { ...f.identity, subscriptionType: 'api' },
    { ...f.identity, apiProvider: 'vertex' },
  ]) {
    f.writeStatus(status);
    await expect(custody.verify(f.env, new AbortController().signal)).rejects.toThrow(
      'Claude subscription',
    );
  }
  expect(() => custody.assertCurrent({ ...f.env, ANTHROPIC_API_KEY: 'secret' })).toThrow();
  renameSync(f.config, f.config + '-old');
  mkdirSync(f.config, { mode: 0o700 });
  expect(() => custody.assertCurrent(f.env)).toThrow();
});

it('retains native failure output in the original cause without exposing it in serialized errors', async () => {
  const f = fixture(true),
    custody = ClaudeSubscriptionCustody.capture(f.env, f.executable);
  try {
    await custody.verify(f.env, new AbortController().signal);
    throw Error('verification unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeSubscriptionSignInError);
    const failure = error as ClaudeSubscriptionSignInError;
    expect(failure.cause).toMatchObject({
      stdout: expect.stringContaining(f.identity.email),
      stderr: expect.stringContaining(f.identity.email),
    });
    expect(Object.prototype.propertyIsEnumerable.call(failure, 'cause')).toBe(false);
    expect(JSON.parse(JSON.stringify(failure))).toMatchObject({
      reason: 'native_command_failed',
      code: 'claude_subscription_sign_in_unavailable',
      diagnosticId: expect.any(String),
    });
    expect(JSON.stringify(failure)).not.toMatch(/person@|stdout|stderr|loggedIn|options/);
  }
});

it('retains original cancellation and malformed-status causes with safe correlated diagnostics', async () => {
  const f = fixture(),
    custody = ClaudeSubscriptionCustody.capture(f.env, f.executable);
  const controller = new AbortController();
  const cause = Error('Private cancellation detail');
  controller.abort(cause);
  await expect(custody.verify(f.env, controller.signal)).rejects.toMatchObject({
    cause,
    reason: 'cancelled',
    code: 'claude_subscription_sign_in_unavailable',
    stage: 'claude_sign_in_verification',
    diagnosticId: expect.any(String),
  });
  writeFileSync(join(f.root, 'status.json'), 'private malformed output');
  try {
    await custody.verify(f.env, new AbortController().signal);
    throw Error('verification unexpectedly succeeded');
  } catch (error) {
    expect(error).toMatchObject({ reason: 'invalid_response', cause: expect.any(SyntaxError) });
    const diagnostic = (error as Error & { telemetry(): object }).telemetry();
    expect(diagnostic).toMatchObject({
      reason: 'invalid_response',
      diagnosticId: expect.any(String),
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|malformed/);
    expect(JSON.stringify(error)).not.toMatch(/private|malformed/);
  }
});
