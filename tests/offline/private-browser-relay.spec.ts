import { test, expect, chromium } from '@playwright/test';
import { createPrivateRelayBrowser } from '../../server/secret-relay-browser-driver';
import { BrowserRelayTargetSchema, PrivateRelayBrowsers } from '../../server/secret-relay-browser';
test('private browser authenticates with CSRF cookies, requests MFA and continues a reviewed action without exporting state', async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Private browser adapter uses Chromium on the controller.',
  );
  const seen: Array<{ url: string; method: string; body: string; cookie: string }> = [];
  let signedIn = false;
  let saved = false;
  const target = BrowserRelayTargetSchema.parse({
    adapter: 'browser',
    origin: 'https://service.example',
    requests: [
      { path: '/login', methods: ['GET', 'POST'] },
      { path: '/extra', methods: ['POST'] },
      { path: '/otp', methods: ['POST'] },
      { path: '/whoami', methods: ['GET'] },
      { path: '/settings', methods: ['GET', 'POST'] },
    ],
    login: {
      path: '/login',
      usernameSelector: '#user',
      username: 'fixture-user',
      passwordSelector: '#password',
      submitSelector: '#login',
    },
    mfa: { codeSelector: '#code', submitSelector: '#verify' },
    verification: { path: '/whoami', pointer: '/authenticated', equals: true },
    actions: [
      {
        label: 'Save setting',
        path: '/settings',
        fields: [{ selector: '#setting', value: 'enabled' }],
        submitSelector: '#save',
        verification: { path: '/whoami', pointer: '/saved', equals: true },
      },
    ],
  });
  const sessions = new PrivateRelayBrowsers((t) =>
    createPrivateRelayBrowser(t, {
      launch: () =>
        chromium.launch({
          headless: true,
          proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
        }),
      send: async (_target, url, method, headers, body) => {
        const path = new URL(url).pathname;
        const entry = { url, method, body: body?.toString() ?? '', cookie: headers.cookie ?? '' };
        seen.push(entry);
        if (path === '/extra')
          return {
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: Buffer.from('ok'),
          };
        if (path === '/whoami')
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ authenticated: signedIn, saved })),
          };
        if (path === '/login' && method === 'GET')
          return {
            status: 200,
            headers: {
              'content-type': 'text/html',
              'set-cookie': 'csrf=private-csrf; Secure; HttpOnly; Path=/',
            },
            body: Buffer.from(
              '<form hidden method="post" action="/login"><input id="user" name="user"><input id="password" type="password" name="password"><input name="csrf" value="private-csrf" type="hidden"><button id="login">Sign in</button></form><script>(async()=>{try{await fetch("/extra",{method:"POST"});await fetch("/extra",{method:"POST"});}catch{}finally{document.querySelector("form").hidden=false;}})();fetch("https://blocked.example/escape").catch(()=>{});new WebSocket("wss://blocked.example/escape");</script>',
            ),
          };
        if (path === '/login' && method === 'POST') {
          expect(entry.cookie).toContain('csrf=private-csrf');
          expect(entry.body).toContain('password=private-password');
          expect(entry.body).toContain('csrf=private-csrf');
          return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: Buffer.from(
              '<form method="post" action="/otp"><input id="code" name="code"><button id="verify">Verify</button></form>',
            ),
          };
        }
        if (path === '/otp') {
          expect(entry.body).toBe('code=123456');
          signedIn = true;
          return {
            status: 200,
            headers: {
              'content-type': 'text/html',
              'set-cookie': 'session=private-session; Secure; HttpOnly; Path=/',
            },
            body: Buffer.from('<p>Signed in</p>'),
          };
        }
        if (path === '/settings' && method === 'GET') {
          expect(entry.cookie).toContain('session=private-session');
          return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: Buffer.from(
              '<form method="post" action="/settings"><input name="setting" id="setting"><button id="save">Save</button></form>',
            ),
          };
        }
        if (path === '/settings' && method === 'POST') {
          expect(entry.body).toBe('setting=enabled');
          saved = true;
          return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: Buffer.from('<p>Saved</p>'),
          };
        }
        throw new Error('Unexpected offline fixture request');
      },
    }),
  );
  const gate = () => ({
    signal: AbortSignal.timeout(15000),
    check: () => {},
    dispatched: () => {},
  });
  try {
    const receipt = await sessions.login(
      'relay:0',
      target,
      'private-password',
      Date.now() + 30000,
      gate(),
    );
    expect(receipt).toEqual({ outcome: 'challenge_required' });
    await sessions.completeCode('relay:0', '123456', gate());
    expect(await sessions.action('relay:0', 0, gate())).toEqual({ outcome: 'confirmed' });
    expect(seen.some((e) => e.url.includes('blocked.example'))).toBe(false);
    expect(seen.filter((e) => e.url.endsWith('/extra'))).toHaveLength(1);
    expect(seen.filter((e) => e.url.endsWith('/login') && e.method === 'POST')).toHaveLength(1);
    expect(seen.filter((e) => e.url.endsWith('/otp'))).toHaveLength(1);
  } finally {
    await sessions.dispose();
  }
});
