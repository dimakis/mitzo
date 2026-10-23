import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';
import { isAllowedConnectionAddress } from './credential-http.js';
import {
  assertBrowserGate,
  browserRequestAllowed,
  type BrowserRelayTarget,
  type BrowserGate,
  type PrivateBrowserDriver,
} from './secret-relay-browser.js';
export function validateBrowserDestination(
  addresses: Array<{ address: string; family: number }>,
  allowPrivate: boolean,
) {
  const local = Object.values(networkInterfaces())
    .flat()
    .map((i) => i?.address);
  if (
    !addresses.length ||
    addresses.length > 16 ||
    addresses.some(
      (a) =>
        isIP(a.address) !== a.family ||
        !isAllowedConnectionAddress(a.address, allowPrivate) ||
        local.includes(a.address),
    )
  )
    throw new Error('Private browser destination blocked');
  return addresses[0].address;
}
export function browserResponseHeaders(headers: Record<string, string | string[] | undefined>) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers))
    if (
      value !== undefined &&
      ![
        'connection',
        'transfer-encoding',
        'content-length',
        'content-encoding',
        'keep-alive',
        'upgrade',
        'proxy-authenticate',
        'cache-control',
        'alt-svc',
      ].includes(key)
    )
      result[key] = Array.isArray(value) ? value.join(key === 'set-cookie' ? '\n' : ', ') : value;
  result['cache-control'] = 'no-store';
  return result;
}
type Response = { status: number; headers: Record<string, string>; body: Buffer };
export type BrowserSend = (
  target: BrowserRelayTarget,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  gate: BrowserGate,
) => Promise<Response>;
/** All browser HTTP is fulfilled by this host transport. DNS is checked as a
 * complete set, pinned, and fenced again immediately before request creation. */
export const sendPrivateBrowserRequest: BrowserSend = async (
  target,
  value,
  method,
  headers,
  body,
  gate,
) => {
  if (
    !browserRequestAllowed(target, value, method) ||
    (body?.length ?? 0) > 32768 ||
    Buffer.byteLength(JSON.stringify(headers)) > 32768
  )
    throw new Error('Private browser request blocked');
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  const address = validateBrowserDestination(addresses, target.allowPrivateNetwork);
  const safe: Record<string, string> = {};
  for (const [key, v] of Object.entries(headers))
    if (
      ![
        'host',
        'connection',
        'content-length',
        'transfer-encoding',
        'accept-encoding',
        'upgrade',
        'te',
        'trailer',
      ].includes(key.toLowerCase()) &&
      !key.toLowerCase().startsWith('proxy-')
    )
      safe[key] = v;
  safe['accept-encoding'] = 'identity';
  if (body) safe['content-length'] = String(body.length);
  await assertBrowserGate(gate);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers: safe,
        agent: false,
        rejectUnauthorized: true,
        signal: gate.signal,
        maxHeaderSize: 16384,
        lookup: (_host, options, callback) => {
          void assertBrowserGate(gate).then(
            () =>
              options.all
                ? callback(null, [{ address, family: addresses[0].family }])
                : callback(null, address, addresses[0].family),
            () => callback(new Error('Private browser authority changed'), [], undefined),
          );
        },
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (b: Buffer) => {
          size += b.length;
          if (size > 512 * 1024) {
            res.destroy();
            reject(new Error('Private browser response too large'));
          } else chunks.push(b);
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Private browser response interrupted')));
        res.on('end', () => {
          try {
            let bytes = Buffer.concat(chunks);
            const encoding = res.headers['content-encoding'];
            const options = { maxOutputLength: 512 * 1024 };
            if (encoding === 'gzip') bytes = gunzipSync(bytes, options);
            else if (encoding === 'br') bytes = brotliDecompressSync(bytes, options);
            else if (encoding === 'deflate') bytes = inflateSync(bytes, options);
            else if (encoding && encoding !== 'identity') throw new Error();
            resolve({
              status: res.statusCode ?? 0,
              headers: browserResponseHeaders(res.headers),
              body: bytes,
            });
          } catch {
            reject(new Error('Private browser response unavailable'));
          }
        });
      },
    );
    req.on('error', () => reject(new Error('Private browser request failed')));
    req.end(body);
  });
};
export function verifyBrowserResponse(
  verification: BrowserRelayTarget['verification'],
  status: number,
  body: Buffer,
) {
  try {
    if (status < 200 || status >= 300) throw new Error();
    let value: unknown = JSON.parse(body.toString('utf8'));
    for (const raw of verification.pointer.slice(1).split('/')) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (
        !value ||
        typeof value !== 'object' ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        !Object.hasOwn(value, key)
      )
        throw new Error();
      value = (value as Record<string, unknown>)[key];
    }
    if (value !== verification.equals) throw new Error();
  } catch {
    throw new Error('Private browser verification failed');
  }
}
export function privateBrowserLaunchOptions(env: NodeJS.ProcessEnv): LaunchOptions {
  if (
    Object.entries(env).some(
      ([key, value]) =>
        value && (key === 'DEBUG' || key === 'PWDEBUG' || key.startsWith('PW_TEST_')),
    )
  )
    throw new Error(
      'Private browser requires debug logging and external browser attachment to be disabled',
    );
  const safe: Record<string, string> = {};
  for (const key of [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
  ])
    if (env[key]) safe[key] = env[key]!;
  return {
    headless: true,
    chromiumSandbox: true,
    env: safe,
    proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
    args: [
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  };
}
/** No external browser/CDP attachment, persistent profile, screenshots, tracing,
 * downloads or state export. Unknown traffic fails closed at two boundaries:
 * context routing and an unreachable proxy for any browser-internal bypass. */
export async function createPrivateRelayBrowser(
  target: BrowserRelayTarget,
  options: { send?: BrowserSend; launch?: () => Promise<Browser> } = {},
): Promise<PrivateBrowserDriver> {
  const browser = await (options.launch?.() ??
    chromium.launch(privateBrowserLaunchOptions(process.env)));
  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      permissions: [],
    });
    let active: BrowserGate | undefined;
    const writes = new Set<string>();
    const send = options.send ?? sendPrivateBrowserRequest;
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.route('**/*', async (route) => {
      try {
        const gate = active;
        const req = route.request();
        if (!gate || !browserRequestAllowed(target, req.url(), req.method())) throw new Error();
        await assertBrowserGate(gate);
        const headers = await req.allHeaders();
        if (active !== gate) throw new Error();
        if (!['GET', 'HEAD'].includes(req.method())) {
          const key = `${req.method()}:${new URL(req.url()).pathname}`;
          if (writes.has(key)) throw new Error('Private browser duplicate write blocked');
          writes.add(key);
        }
        const requestGate = {
          ...gate,
          check: () => {
            if (active !== gate) throw new Error('Private browser request scope ended');
            gate.check();
          },
        };
        const response = await send(
          target,
          req.url(),
          req.method(),
          headers,
          req.postDataBuffer() ?? undefined,
          requestGate,
        );
        await assertBrowserGate(gate);
        if (active !== gate) throw new Error();
        await route.fulfill(response);
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(15000);
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => {});
    });
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    const atOrigin = () => {
      if (new URL(page.url()).origin !== target.origin || page.frames().length !== 1)
        throw new Error('Private browser page changed');
    };
    const verify = async (gate: BrowserGate, verification = target.verification) => {
      const url = new URL(verification.path, target.origin).href;
      const cookies = await context.cookies(url);
      await assertBrowserGate(gate);
      const response = await send(
        target,
        url,
        'GET',
        {
          cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
          accept: 'application/json',
        },
        undefined,
        gate,
      );
      await assertBrowserGate(gate);
      verifyBrowserResponse(verification, response.status, response.body);
    };
    const run = async <T>(gate: BrowserGate, work: () => Promise<T>): Promise<T> => {
      if (active) throw new Error('Private browser busy');
      await assertBrowserGate(gate);
      active = gate;
      writes.clear();
      const abort = () => {
        void context.close().catch(() => {});
      };
      gate.signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await work();
        await assertBrowserGate(gate);
        return result;
      } catch {
        throw new Error('Private browser operation unconfirmed');
      } finally {
        active = undefined;
        gate.signal.removeEventListener('abort', abort);
      }
    };
    return {
      login: (password, gate) =>
        run(gate, async () => {
          await page.goto(new URL(target.login.path, target.origin).href, {
            waitUntil: 'domcontentloaded',
          });
          await assertBrowserGate(gate);
          atOrigin();
          if (target.login.usernameSelector)
            await page.locator(target.login.usernameSelector).fill(target.login.username!);
          await assertBrowserGate(gate);
          atOrigin();
          await page.locator(target.login.passwordSelector).fill(password);
          await assertBrowserGate(gate);
          atOrigin();
          await page.locator(target.login.submitSelector).click();
          await page.waitForLoadState('domcontentloaded');
          await assertBrowserGate(gate);
          atOrigin();
          try {
            await verify(gate);
            await page.goto('about:blank');
            return { challenge: false };
          } catch {
            await assertBrowserGate(gate);
            if (target.mfa && (await page.locator(target.mfa.codeSelector).isVisible()))
              return { challenge: true };
            throw new Error();
          }
        }),
      code: (value, gate) =>
        run(gate, async () => {
          if (!target.mfa) throw new Error();
          atOrigin();
          await page.locator(target.mfa.codeSelector).fill(value);
          await assertBrowserGate(gate);
          atOrigin();
          await page.locator(target.mfa.submitSelector).click();
          await page.waitForLoadState('domcontentloaded');
          await verify(gate);
          await page.goto('about:blank');
        }),
      action: (action, gate) =>
        run(gate, async () => {
          await verify(gate);
          await page.goto(new URL(action.path, target.origin).href, {
            waitUntil: 'domcontentloaded',
          });
          atOrigin();
          for (const field of action.fields) {
            await assertBrowserGate(gate);
            atOrigin();
            await page.locator(field.selector).fill(field.value);
          }
          await assertBrowserGate(gate);
          atOrigin();
          await page.locator(action.submitSelector).click();
          await page.waitForLoadState('domcontentloaded');
          await verify(gate, action.verification);
          await page.goto('about:blank');
        }),
      close: () => browser.close(),
    };
  } catch {
    await browser.close().catch(() => {});
    throw new Error('Private browser unavailable');
  }
}
