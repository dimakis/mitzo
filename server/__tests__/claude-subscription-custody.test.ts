import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeSubscriptionCustody } from '../claude-subscription-custody.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-custody-')));
  roots.push(root);
  const config = join(root, 'personal');
  mkdirSync(config, { mode: 0o700 });
  const executable = join(root, 'claude');
  const status = join(root, 'status.json');
  writeFileSync(executable, '#!/bin/sh\ncat "' + status + '"\n', { mode: 0o700 });
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
  }
});
