import { expect, it } from 'vitest';
import {
  validateBrowserDestination,
  browserResponseHeaders,
  verifyBrowserResponse,
} from '../secret-relay-browser-driver.js';
it('pins only allowed addresses and refuses controller and mixed DNS answers', () => {
  expect(validateBrowserDestination([{ address: '93.184.216.34', family: 4 }], false)).toBe(
    '93.184.216.34',
  );
  for (const answers of [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
    [],
  ])
    expect(() => validateBrowserDestination(answers, false)).toThrow();
});
it('keeps cookies private and removes transport and disk-cache headers from fulfilled pages', () => {
  expect(
    browserResponseHeaders({
      'set-cookie': ['first=private; Secure', 'second=private; Secure'],
      'content-type': 'text/html',
      'content-length': '10',
      connection: 'keep-alive',
      'content-encoding': 'gzip',
    }),
  ).toEqual({
    'set-cookie': 'first=private; Secure\nsecond=private; Secure',
    'content-type': 'text/html',
    'cache-control': 'no-store',
  });
});
it('requires an authenticated verification response without exposing its body', () => {
  const verification = { path: '/whoami', pointer: '/user/authenticated', equals: true };
  expect(
    verifyBrowserResponse(verification, 200, Buffer.from('{"user":{"authenticated":true}}')),
  ).toBeUndefined();
  for (const [status, body] of [
    [302, '{}'],
    [401, '{"user":{"authenticated":true}}'],
    [200, '{"user":{"authenticated":false}}'],
    [200, 'private-password'],
  ])
    expect(() =>
      verifyBrowserResponse(verification, status as number, Buffer.from(body as string)),
    ).toThrow('Private browser verification failed');
});
