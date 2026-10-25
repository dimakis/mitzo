import { expect, it, vi } from 'vitest';
import {
  BrowserRelayTargetSchema,
  PrivateRelayBrowsers,
  browserRequestAllowed,
} from '../secret-relay-browser.js';
const target = {
  adapter: 'browser' as const,
  origin: 'https://service.example',
  allowPrivateNetwork: false,
  requests: [
    { path: '/login', methods: ['GET', 'POST'] },
    { path: '/otp', methods: ['POST'] },
    { path: '/whoami', methods: ['GET'] },
    { path: '/settings', methods: ['GET', 'POST'] },
  ],
  login: {
    path: '/login',
    usernameSelector: '#user',
    username: 'device',
    passwordSelector: '#password',
    submitSelector: '#login',
  },
  mfa: { codeSelector: '#code', submitSelector: '#verify' },
  verification: { path: '/whoami', pointer: '/authenticated', equals: true },
  actions: [
    {
      label: 'Save settings',
      path: '/settings',
      fields: [{ selector: '#enabled', value: 'yes' }],
      submitSelector: '#save',
    },
  ],
};
function fixture(challenge = false) {
  const driver = {
    login: vi.fn(async () => ({ challenge })),
    code: vi.fn(async () => {}),
    action: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const create = vi.fn(async () => driver);
  const service = new PrivateRelayBrowsers(create);
  return { driver, service, create };
}
const gate = () => ({
  signal: AbortSignal.timeout(1000),
  check: () => {},
  assertCurrent: async () => {},
  dispatched: vi.fn(),
});
it('keeps a private browser session and permits only the exact reviewed action', async () => {
  const f = fixture();
  expect(
    await f.service.login(
      'relay:0',
      BrowserRelayTargetSchema.parse(target),
      'private-password',
      Date.now() + 1000,
      gate(),
    ),
  ).toEqual({ outcome: 'confirmed' });
  await f.service.action('relay:0', 0, gate());
  expect(f.driver.action).toHaveBeenCalledWith(target.actions[0], expect.anything());
  await expect(f.service.action('relay:0', 1, gate())).rejects.toThrow();
  await f.service.closeRelay('relay');
  expect(f.driver.close).toHaveBeenCalledOnce();
  await expect(f.service.action('relay:0', 0, gate())).rejects.toThrow();
});
it('requires a private MFA completion before continuing and never passes OTP into metadata', async () => {
  const f = fixture(true);
  const receipt = await f.service.login(
    'relay:0',
    BrowserRelayTargetSchema.parse(target),
    'private-password',
    Date.now() + 1000,
    gate(),
  );
  expect(receipt).toEqual({ outcome: 'challenge_required' });
  expect(JSON.stringify(receipt)).not.toMatch(/private|password/);
  await expect(f.service.action('relay:0', 0, gate())).rejects.toThrow();
  await f.service.completeCode('relay:0', '123456', gate());
  expect(f.driver.code).toHaveBeenCalledWith('123456', expect.anything());
  await expect(f.service.completeCode('relay:0', '123456', gate())).rejects.toThrow();
  await f.service.action('relay:0', 0, gate());
  await f.service.closeRelay('relay');
});
it('expires sessions, fails closed after restart and rechecks authority after awaited creation', async () => {
  const f = fixture();
  const authority = gate();
  f.create.mockImplementationOnce(async () => {
    authority.check = () => {
      throw new Error('revoked');
    };
    return f.driver;
  });
  await expect(
    f.service.login(
      'relay:0',
      BrowserRelayTargetSchema.parse(target),
      'private-password',
      Date.now() + 1000,
      authority,
    ),
  ).rejects.toThrow();
  expect(f.driver.login).not.toHaveBeenCalled();
  expect(f.driver.close).toHaveBeenCalledOnce();
  await expect(new PrivateRelayBrowsers(f.create).action('relay:0', 0, gate())).rejects.toThrow();
  const ready = fixture();
  await ready.service.login(
    'relay:0',
    BrowserRelayTargetSchema.parse(target),
    'fixture',
    Date.now() + 10,
    gate(),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(ready.driver.close).toHaveBeenCalledOnce();
  await expect(ready.service.action('relay:0', 0, gate())).rejects.toThrow();
});
it('restricts every request to the reviewed HTTPS origin, methods and paths', () => {
  const parsed = BrowserRelayTargetSchema.parse(target);
  expect(browserRequestAllowed(parsed, 'https://service.example/login', 'POST')).toBe(true);
  for (const [url, method] of [
    ['https://other.example/login', 'POST'],
    ['https://service.example/admin', 'POST'],
    ['https://service.example/login', 'DELETE'],
    ['http://service.example/login', 'POST'],
    ['https://service.example/login/../admin', 'POST'],
  ])
    expect(browserRequestAllowed(parsed, url, method)).toBe(false);
  for (const origin of [
    'http://service.example',
    'https://service.example/path',
    'https://user:pass@service.example',
    'https://127.0.0.1',
  ])
    expect(BrowserRelayTargetSchema.safeParse({ ...target, origin }).success).toBe(false);
});
