import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CredentialVault, VaultReference } from './keychain-vault.js';

function normalizedJsonNumber(value: string): string | undefined {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return undefined;
  const fraction = match[3] ?? '';
  const digits = `${match[2]}${fraction}`.replace(/^0+/, '');
  if (!digits) return '0';
  const coefficient = digits.replace(/0+$/, '');
  // Compare exact decimal values without floating-point rounding or overflow.
  const exponent =
    BigInt(match[4] ?? '0') - BigInt(fraction.length) + BigInt(digits.length - coefficient.length);
  return `${match[1]}${coefficient}e${exponent}`;
}

const header = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
  .refine(
    (name) =>
      ![
        'host',
        'cookie',
        'proxy-authorization',
        'content-length',
        'transfer-encoding',
        'connection',
        'content-type',
        'accept',
        'accept-encoding',
      ].includes(name.toLowerCase()),
    'Reserved authentication header',
  );
export const ConnectionAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bearer') }).strict(),
  z
    .object({
      kind: z.literal('basic'),
      username: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[^:\r\n]+$/),
    })
    .strict(),
  z.object({ kind: z.literal('api-key'), headerName: header }).strict(),
  z.object({ kind: z.literal('password'), headerName: header }).strict(),
]);
export const ConnectionInputSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    endpoint: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const u = new URL(value);
          return (
            u.protocol === 'https:' &&
            !u.username &&
            !u.password &&
            u.pathname === '/' &&
            !u.search &&
            !u.hash &&
            u.origin === value
          );
        } catch {
          return false;
        }
      }, 'Use an HTTPS origin without a path, username or password'),
    auth: ConnectionAuthSchema,
    paths: z
      .array(
        z
          .string()
          .max(512)
          .regex(/^\/[A-Za-z0-9_/-]*$/)
          .refine((p) => !p.includes('//')),
      )
      .min(1)
      .max(16),
    methods: z
      .array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']))
      .min(1)
      .max(6),
    allowPrivateNetwork: z.boolean().default(false),
  })
  .strict();
export type CredentialConnectionInput = z.infer<typeof ConnectionInputSchema>;
export interface CredentialConnection extends CredentialConnectionInput {
  id: string;
  revision: number;
  status: 'active' | 'disabled';
  credentialRef: VaultReference;
  ownsCredential: boolean;
  verifiedAt: number | null;
}
export type PublicCredentialConnection = Omit<
  CredentialConnection,
  'credentialRef' | 'ownsCredential'
>;
export const publicCredentialConnection = ({
  credentialRef: _ref,
  ownsCredential: _owns,
  ...connection
}: CredentialConnection): PublicCredentialConnection => connection;

/** Metadata and exact-session grants only. No credential values or request bodies enter SQLite. */
export class CredentialConnectionStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS credential_connections (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credential_connection_grants (session_id TEXT NOT NULL, connection_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(session_id, connection_id));`);
  }
  get(id: string): CredentialConnection | undefined {
    const row = this.db
      .prepare('SELECT metadata FROM credential_connections WHERE id=?')
      .get(id) as { metadata: string } | undefined;
    return row ? JSON.parse(row.metadata) : undefined;
  }
  list(): CredentialConnection[] {
    return (
      this.db.prepare('SELECT metadata FROM credential_connections ORDER BY rowid DESC').all() as {
        metadata: string;
      }[]
    ).map((r) => JSON.parse(r.metadata));
  }
  put(c: CredentialConnection) {
    this.db
      .prepare('INSERT OR REPLACE INTO credential_connections VALUES (?, ?)')
      .run(c.id, JSON.stringify(c));
  }
  replaceAtRevision(c: CredentialConnection, revision: number): boolean {
    return this.db.transaction(() => {
      if (this.get(c.id)?.revision !== revision) return false;
      this.put(c);
      return true;
    })();
  }
  grant(session: string, c: CredentialConnection) {
    this.db
      .prepare('INSERT OR REPLACE INTO credential_connection_grants VALUES (?, ?, ?)')
      .run(session, c.id, c.revision);
  }
  hasGrant(session: string, c: CredentialConnection) {
    return !!this.db
      .prepare(
        'SELECT 1 FROM credential_connection_grants WHERE session_id=? AND connection_id=? AND revision=?',
      )
      .get(session, c.id, c.revision);
  }
  revoke(session: string, id: string) {
    this.db
      .prepare('DELETE FROM credential_connection_grants WHERE session_id=? AND connection_id=?')
      .run(session, id);
  }
  revokeAll(id: string) {
    this.db.prepare('DELETE FROM credential_connection_grants WHERE connection_id=?').run(id);
  }
  grants(id: string) {
    return this.db
      .prepare(
        'SELECT session_id AS sessionId, revision FROM credential_connection_grants WHERE connection_id=?',
      )
      .all(id) as Array<{ sessionId: string; revision: number }>;
  }
  close() {
    this.db.close();
  }
}
export const ConnectionRequestSchema = z
  .object({
    path: z.string().min(1).max(4096),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    body: z
      .string()
      .max(32 * 1024)
      .optional(),
  })
  .strict();
export type ConnectionRequest = z.infer<typeof ConnectionRequestSchema>;
export interface AuthenticatedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  allowPrivateNetwork: boolean;
}
export type ConnectionSender = (
  request: AuthenticatedRequest,
  signal: AbortSignal,
) => Promise<{ status: number; body: string }>;

export function requestTarget(
  c: Pick<CredentialConnectionInput, 'endpoint' | 'paths'>,
  path: string,
): URL {
  const pathname = path.split('?')[0];
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\#\r\n]/.test(path) ||
    /[%]|\.\./.test(pathname) ||
    pathname.includes('//')
  )
    throw new Error('Invalid connection path');
  const target = new URL(path, c.endpoint);
  if (
    target.origin !== c.endpoint ||
    !c.paths.some(
      (prefix) =>
        target.pathname === prefix ||
        target.pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'),
    )
  )
    throw new Error('Connection path is outside approved access');
  return target;
}

export class CredentialConnections {
  private active = new Map<string, Set<AbortController>>();
  constructor(
    private store: CredentialConnectionStore,
    private vault: CredentialVault,
    private send: ConnectionSender,
  ) {}
  catalog(session?: string) {
    return this.store.list().map((c) => ({
      ...publicCredentialConnection(c),
      access:
        c.status !== 'active'
          ? 'unavailable'
          : session && this.store.hasGrant(session, c)
            ? 'approved'
            : 'approval_required',
    }));
  }
  connection(id: string, revision?: number) {
    const c = this.store.get(id);
    if (!c || c.status !== 'active') throw new Error('Connection unavailable');
    if (revision !== undefined && c.revision !== revision)
      throw new Error('Connection changed; refresh and try again');
    return c;
  }
  async create(input: unknown, source: { secret: string } | { existing: VaultReference }) {
    const parsed = ConnectionInputSchema.parse(input);
    const id = randomUUID();
    const credentialRef =
      'secret' in source
        ? await this.vault.save(id, source.secret)
        : await this.vault.link(source.existing);
    const c: CredentialConnection = {
      ...parsed,
      id,
      revision: 1,
      status: 'active',
      credentialRef,
      ownsCredential: 'secret' in source,
      verifiedAt: null,
    };
    this.store.put(c);
    return publicCredentialConnection(c);
  }
  sessions(id: string) {
    return this.store.grants(id);
  }
  async test(id: string, revision: number, path: string, signal: AbortSignal) {
    this.connection(id, revision);
    const session = `connection-test:${randomUUID()}`;
    this.grant(session, id, revision);
    try {
      const result = await this.request(session, id, { path, method: 'GET' }, signal);
      if (result.status < 200 || result.status >= 300)
        throw new Error('Connection verification failed');
      const verified = { ...this.connection(id, revision), verifiedAt: Date.now() };
      this.store.put(verified);
      return { status: result.status, connection: publicCredentialConnection(verified) };
    } finally {
      this.revokeSession(session, id);
    }
  }
  grant(session: string, id: string, revision: number) {
    this.store.grant(session, this.connection(id, revision));
  }
  private cancel(id: string, session?: string) {
    for (const [key, controllers] of this.active)
      if (key === `${session}:${id}` || (!session && key.endsWith(`:${id}`)))
        controllers.forEach((c) => c.abort());
  }
  revokeSession(session: string, id: string) {
    this.store.revoke(session, id);
    this.cancel(id, session);
  }
  disable(id: string, revision: number) {
    const c = this.connection(id, revision);
    this.store.revokeAll(id);
    this.cancel(id);
    this.store.put({ ...c, revision: revision + 1, status: 'disabled' });
  }
  async rotate(id: string, revision: number, secret: string) {
    const c = this.store.get(id);
    if (!c || !['active', 'disabled'].includes(c.status)) throw new Error('Connection unavailable');
    if (c.revision !== revision) throw new Error('Connection changed; refresh and try again');
    // Invalidate and stop access BEFORE the asynchronous Keychain write.
    this.store.revokeAll(id);
    this.cancel(id);
    const next = { ...c, revision: revision + 1, status: 'disabled' as const, verifiedAt: null };
    if (!this.store.replaceAtRevision(next, revision))
      throw new Error('Connection changed; refresh and try again');
    const credentialRef = await this.vault.save(`${id}-${next.revision}`, secret);
    const updated: CredentialConnection = {
      ...next,
      status: 'active',
      credentialRef,
      ownsCredential: true,
    };
    // Another replacement can begin while Keychain is writing. Never restore its
    // older revision or revive access after a newer operation has taken ownership.
    if (!this.store.replaceAtRevision(updated, next.revision)) {
      await this.removeUnusedCredential(credentialRef);
      throw new Error('Connection changed; refresh and try again');
    }
    // Linked items remain owned by their original app; never update or delete them.
    if (c.ownsCredential) await this.removeUnusedCredential(c.credentialRef);
    return publicCredentialConnection(updated);
  }
  private async removeUnusedCredential(ref: VaultReference) {
    const shared = this.store
      .list()
      .some((other) =>
        ref.persistentRef
          ? other.credentialRef.persistentRef === ref.persistentRef
          : other.credentialRef.service === ref.service &&
            other.credentialRef.account === ref.account,
      );
    if (!shared) await this.vault.remove(ref).catch(() => {});
  }
  async request(
    session: string,
    id: string,
    input: unknown,
    signal: AbortSignal,
    stillAllowed: () => boolean = () => true,
  ) {
    const c = this.connection(id);
    const request = ConnectionRequestSchema.parse(input);
    const url = requestTarget(c, request.path);
    if (
      !c.methods.includes(request.method) ||
      (['GET', 'HEAD'].includes(request.method) && request.body !== undefined)
    )
      throw new Error('Request method is outside approved access');
    const check = () => {
      signal.throwIfAborted();
      if (
        !stillAllowed() ||
        this.connection(id).revision !== c.revision ||
        !this.store.hasGrant(session, c)
      )
        throw new Error('Session approval required');
    };
    check();
    const controller = new AbortController();
    const key = `${session}:${id}`;
    const controllers = this.active.get(key) ?? new Set();
    controllers.add(controller);
    this.active.set(key, controllers);
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30_000)]);
    try {
      const secret = await this.vault.read(c.credentialRef);
      combined.throwIfAborted();
      check();
      if (!secret || /[\r\n]/.test(secret)) throw new Error('Credential unavailable');
      const headers: Record<string, string> =
        c.auth.kind === 'basic'
          ? {
              Authorization: `Basic ${Buffer.from(`${c.auth.username}:${secret}`).toString('base64')}`,
            }
          : c.auth.kind === 'bearer'
            ? { Authorization: `Bearer ${secret}` }
            : { [c.auth.headerName]: secret };
      const response = await this.send(
        {
          url,
          method: request.method,
          headers,
          body: request.body,
          allowPrivateNetwork: c.allowPrivateNetwork,
        },
        combined,
      );
      combined.throwIfAborted();
      check();
      const values = [
        ...new Set([
          secret,
          encodeURIComponent(secret),
          Buffer.from(secret).toString('base64'),
          ...Object.values(headers).flatMap((value) => [
            value,
            value.replace(/^(Basic|Bearer) /, ''),
          ]),
        ]),
      ].sort((a, b) => b.length - a.length);
      const redact = (text: string) => {
        for (const value of values) text = text.split(value).join('[redacted]');
        return text;
      };
      // Decode each JSON string before redacting: quote/backslash, Unicode and
      // slash escapes can otherwise hide echoed secrets in both keys and values.
      const decoded = response.body.replace(
        // eslint-disable-next-line no-control-regex -- JSON strings exclude unescaped control characters.
        /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/g,
        (token) => {
          const text = JSON.parse(token) as string;
          const safe = redact(text);
          return safe === text ? token : JSON.stringify(safe);
        },
      );
      let body: string;
      try {
        // In valid JSON, punctuation is structural rather than an echoed secret
        // (for example a password consisting of a quote). Keep it intact.
        JSON.parse(response.body);
        const numbers = new Set(
          values.map(normalizedJsonNumber).filter((value) => value !== undefined),
        );
        body = decoded.replace(
          // Match whole strings too, so their contents cannot be changed here.
          // eslint-disable-next-line no-control-regex -- JSON strings exclude unescaped control characters.
          /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
          (token) => {
            const number = normalizedJsonNumber(token);
            return (number !== undefined && numbers.has(number)) ||
              (['true', 'false', 'null'].includes(token) && values.includes(token))
              ? '"[redacted]"'
              : token;
          },
        );
      } catch {
        body = redact(decoded);
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof Error && error.name === 'KeychainUnavailableError') throw error;
      if (signal.aborted || controller.signal.aborted)
        // eslint-disable-next-line preserve-caught-error -- Upstream errors may contain secrets.
        throw new Error('Connection request cancelled');
      // eslint-disable-next-line preserve-caught-error -- Upstream errors may contain secrets.
      throw new Error('Connection request failed');
    } finally {
      controllers.delete(controller);
      if (!controllers.size) this.active.delete(key);
    }
  }
}
