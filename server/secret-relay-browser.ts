import { z } from 'zod';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isAllowedConnectionAddress } from './credential-http.js';
import { requestTarget } from './credential-connections.js';
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    try {
      requestTarget({ endpoint: 'https://relay.invalid', paths: ['/'] }, value);
      return true;
    } catch {
      return false;
    }
  });
const selector = z.string().min(1).max(256);
const verification = z
  .object({
    path,
    pointer: z
      .string()
      .min(1)
      .max(256)
      .regex(/^(?:\/(?:[^~]|~0|~1)*)+$/),
    equals: z.union([z.string().max(256), z.number().finite(), z.boolean()]),
  })
  .strict();
export const BrowserRelayTargetSchema = z
  .object({
    adapter: z.literal('browser'),
    origin: z
      .string()
      .max(512)
      .refine((value) => {
        try {
          const u = new URL(value);
          const host = u.hostname.replace(/^\[|\]$/g, '');
          return (
            u.protocol === 'https:' &&
            value === u.origin &&
            (!isIP(host) || isAllowedConnectionAddress(host, true)) &&
            !Object.values(networkInterfaces())
              .flat()
              .some((i) => i?.address === host)
          );
        } catch {
          return false;
        }
      }),
    allowPrivateNetwork: z.boolean().default(false),
    requests: z
      .array(
        z
          .object({
            path,
            methods: z
              .array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']))
              .min(1)
              .max(6),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    login: z
      .object({
        path,
        usernameSelector: selector.optional(),
        username: z.string().min(1).max(256).optional(),
        passwordSelector: selector,
        submitSelector: selector,
      })
      .strict()
      .refine((v) => !!v.usernameSelector === !!v.username),
    mfa: z.object({ codeSelector: selector, submitSelector: selector }).strict().optional(),
    verification,
    actions: z
      .array(
        z
          .object({
            label: z.string().min(1).max(100),
            path,
            fields: z.array(z.object({ selector, value: z.string().max(4096) }).strict()).max(16),
            submitSelector: selector,
            verification: verification.optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .strict()
  .refine((t) => {
    const host = new URL(t.origin).hostname.replace(/^\[|\]$/g, '');
    return (
      (!isIP(host) || isAllowedConnectionAddress(host, t.allowPrivateNetwork)) &&
      [
        t.login.path,
        t.verification.path,
        ...t.actions.map((a) => a.path),
        ...t.actions.flatMap((a) => (a.verification ? [a.verification.path] : [])),
      ].every((p) => browserRequestAllowed(t, new URL(p, t.origin).href, 'GET'))
    );
  });
export type BrowserRelayTarget = z.infer<typeof BrowserRelayTargetSchema>;
export type BrowserAction = BrowserRelayTarget['actions'][number];
export type BrowserGate = {
  signal: AbortSignal;
  check: () => void;
  assertCurrent?: () => Promise<void>;
  dispatched: () => void;
};
export async function assertBrowserGate(gate: BrowserGate) {
  await gate.assertCurrent?.();
  gate.signal.throwIfAborted();
  gate.check();
}
export function browserRequestAllowed(
  target: Pick<BrowserRelayTarget, 'origin' | 'requests'>,
  value: string,
  method: string,
) {
  try {
    const url = new URL(value);
    if (url.origin !== target.origin || url.username || url.password || url.hash) return false;
    requestTarget({ endpoint: target.origin, paths: ['/'] }, url.pathname + url.search);
    return target.requests.some(
      (r) =>
        r.methods.includes(method as never) &&
        (url.pathname === r.path || (r.path.endsWith('/') && url.pathname.startsWith(r.path))),
    );
  } catch {
    return false;
  }
}
export interface PrivateBrowserDriver {
  login(password: string, gate: BrowserGate): Promise<{ challenge: boolean }>;
  code(value: string, gate: BrowserGate): Promise<void>;
  action(action: BrowserAction, gate: BrowserGate): Promise<void>;
  close(): Promise<void>;
}
type Entry = {
  target: BrowserRelayTarget;
  expiresAt: number;
  state: 'starting' | 'challenge' | 'authenticated' | 'busy';
  driver?: PrivateBrowserDriver;
  timer?: ReturnType<typeof setTimeout>;
};
/** Only private host memory contains contexts/cookies. Restarts invalidate every
 * session; callers must never restore them by replaying password or OTP submits. */
export class PrivateRelayBrowsers {
  private entries = new Map<string, Entry>();
  constructor(private create: (target: BrowserRelayTarget) => Promise<PrivateBrowserDriver>) {}
  private current(key: string) {
    const e = this.entries.get(key);
    if (!e || e.expiresAt <= Date.now()) throw new Error('Private browser session unavailable');
    return e;
  }
  private async close(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    if (e.timer) clearTimeout(e.timer);
    await e.driver?.close();
  }
  async closeRelay(id: string) {
    for (const key of this.entries.keys()) if (key.startsWith(`${id}:`)) await this.close(key);
  }
  async dispose() {
    for (const key of this.entries.keys()) await this.close(key);
  }
  async login(
    key: string,
    target: BrowserRelayTarget,
    password: string,
    expiresAt: number,
    gate: BrowserGate,
  ): Promise<{ outcome: 'confirmed' | 'challenge_required' }> {
    if (this.entries.has(key) || expiresAt <= Date.now())
      throw new Error('Private browser session changed');
    const entry: Entry = { target, expiresAt, state: 'starting' };
    this.entries.set(key, entry);
    entry.timer = setTimeout(
      () => {
        void this.close(key).catch(() => {});
      },
      Math.max(1, expiresAt - Date.now()),
    );
    entry.timer.unref();
    try {
      await assertBrowserGate(gate);
      entry.driver = await this.create(target);
      await assertBrowserGate(gate);
      if (this.current(key) !== entry) throw new Error();
      gate.dispatched();
      const result = await entry.driver.login(password, gate);
      await assertBrowserGate(gate);
      if (this.current(key) !== entry) throw new Error();
      entry.state = result.challenge ? 'challenge' : 'authenticated';
      return { outcome: result.challenge ? 'challenge_required' : 'confirmed' };
    } catch {
      await entry.driver?.close().catch(() => {});
      entry.driver = undefined;
      await this.close(key);
      throw new Error('Private browser sign-in unconfirmed');
    }
  }
  async completeCode(key: string, value: string, gate: BrowserGate) {
    const entry = this.current(key);
    if (
      entry.state !== 'challenge' ||
      !entry.target.mfa ||
      !entry.driver ||
      !/^\d{6,10}$/.test(value)
    )
      throw new Error('Private verification unavailable');
    entry.state = 'busy';
    try {
      await assertBrowserGate(gate);
      if (this.current(key) !== entry) throw new Error();
      gate.dispatched();
      await entry.driver.code(value, gate);
      await assertBrowserGate(gate);
      if (this.current(key) !== entry) throw new Error();
      entry.state = 'authenticated';
    } catch {
      await this.close(key).catch(() => {});
      throw new Error('Private verification unconfirmed');
    }
  }
  async action(key: string, index: number, gate: BrowserGate) {
    const entry = this.current(key);
    const action = entry.target.actions[index];
    if (entry.state !== 'authenticated' || !entry.driver || !Number.isInteger(index) || !action)
      throw new Error('Private browser action unavailable');
    entry.state = 'busy';
    try {
      await assertBrowserGate(gate);
      if (this.current(key) !== entry) throw new Error();
      gate.dispatched();
      await entry.driver.action(action, gate);
      await assertBrowserGate(gate);
      if (this.current(key) !== entry) throw new Error();
      entry.state = 'authenticated';
      return { outcome: 'confirmed' as const };
    } catch {
      await this.close(key).catch(() => {});
      throw new Error('Private browser action unconfirmed');
    }
  }
}
