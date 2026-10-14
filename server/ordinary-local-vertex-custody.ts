import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, dirname } from 'node:path';
import { VertexAdcCustodySchema, type VertexAdcCustodySnapshot } from '@mitzo/protocol';
export { VertexAdcCustodySchema, type VertexAdcCustodySnapshot };
const unavailable = () => new Error('Original Vertex credential authority unavailable');
function observe(env: Readonly<Record<string, string | undefined>>): VertexAdcCustodySnapshot {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (
    !path ||
    !isAbsolute(path) ||
    realpathSync(path) !== path ||
    env.CLAUDE_CODE_USE_VERTEX !== '1' ||
    !env.ANTHROPIC_VERTEX_PROJECT_ID ||
    !env.CLOUD_ML_REGION ||
    Object.keys(env).some(
      (key) =>
        /^(GOOGLE_|GCLOUD_)/.test(key) && key !== 'GOOGLE_APPLICATION_CREDENTIALS' && !!env[key],
    ) ||
    [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'GOOGLE_API_KEY',
      'GOOGLE_CLOUD_QUOTA_PROJECT',
      'GOOGLE_CLOUD_PROJECT',
      'GCLOUD_PROJECT',
    ].some((key) => !!env[key])
  )
    throw unavailable();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.uid !== BigInt(process.getuid!()) ||
      (stat.mode & 0o777n) !== 0o600n ||
      stat.nlink !== 1n ||
      stat.size > 1048576n
    )
      throw unavailable();
    const bytes = readFileSync(fd);
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      (parsed?.universe_domain !== undefined && parsed.universe_domain !== 'googleapis.com') ||
      (parsed?.token_uri !== undefined &&
        parsed.token_uri !== 'https://oauth2.googleapis.com/token')
    )
      throw unavailable();
    if (
      !parsed ||
      !['service_account', 'authorized_user', 'external_account'].includes(parsed.type)
    )
      throw unavailable();
    if (
      parsed.type === 'authorized_user' &&
      ['client_id', 'client_secret', 'refresh_token'].some(
        (key) => typeof parsed[key] !== 'string' || !parsed[key],
      )
    )
      throw unavailable();
    if (
      parsed.type === 'service_account' &&
      ['client_email', 'private_key'].some((key) => typeof parsed[key] !== 'string' || !parsed[key])
    )
      throw unavailable();
    // External account executable/URL credential suppliers are not this file-backed contract.
    if (parsed.type === 'external_account') throw unavailable();
    const parent = lstatSync(dirname(path), { bigint: true });
    if (!parent.isDirectory() || parent.uid !== stat.uid || (parent.mode & 0o022n) !== 0n)
      throw unavailable();
    for (const current of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })])
      for (const field of [
        'dev',
        'ino',
        'uid',
        'mode',
        'nlink',
        'size',
        'mtimeNs',
        'ctimeNs',
      ] as const)
        if (current[field] !== stat[field]) throw unavailable();
    return VertexAdcCustodySchema.parse({
      version: 1,
      project: env.ANTHROPIC_VERTEX_PROJECT_ID,
      region: env.CLOUD_ML_REGION,
      adc: {
        path,
        parentDev: String(parent.dev),
        parentIno: String(parent.ino),
        dev: String(stat.dev),
        ino: String(stat.ino),
        uid: String(stat.uid),
        mode: String(stat.mode),
        nlink: String(stat.nlink),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    });
  } finally {
    closeSync(fd);
  }
}
export class VertexAdcCustody {
  private constructor(private readonly retained: VertexAdcCustodySnapshot) {}
  static capture(env: Readonly<Record<string, string | undefined>>) {
    try {
      return new VertexAdcCustody(observe(env));
    } catch {
      throw unavailable();
    }
  }
  static reopen(value: unknown, env: Readonly<Record<string, string | undefined>>) {
    const custody = new VertexAdcCustody(VertexAdcCustodySchema.parse(value));
    custody.assertCurrent(env);
    return custody;
  }
  snapshot() {
    return structuredClone(this.retained);
  }
  assertCurrent(env: Readonly<Record<string, string | undefined>>) {
    try {
      if (JSON.stringify(observe(env)) !== JSON.stringify(this.retained)) throw unavailable();
    } catch {
      throw unavailable();
    }
  }
}
