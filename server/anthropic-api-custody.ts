import { isDeepStrictEqual } from 'node:util';
import { AnthropicApiCustodySchema, type OrdinaryLocalVertexCustody } from '@mitzo/protocol';
import { KeychainRotationCredentials } from './keychain-rotation-credentials.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { createLogger } from './logger.js';
const log = createLogger('anthropic-api-custody');

type Snapshot = Extract<
  OrdinaryLocalVertexCustody['credentialAuthority'],
  { kind: 'anthropic-api-key' }
>;
class AnthropicApiCredentialError extends Error {
  readonly code = 'ANTHROPIC_CREDENTIAL_UNAVAILABLE';
  constructor(cause?: unknown) {
    super('Original Anthropic API credential authority unavailable', { cause });
    this.name = 'AnthropicApiCredentialError';
  }
}
const unavailable = () => new AnthropicApiCredentialError();
function observe(env: Readonly<NodeJS.ProcessEnv>): Snapshot {
  try {
    const snapshot = AnthropicApiCustodySchema.parse(
      JSON.parse(env.MITZO_ANTHROPIC_API_CUSTODY ?? ''),
    );
    if (
      env.CLAUDE_CODE_USE_VERTEX !== '0' ||
      env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB !== '1' ||
      env.ANTHROPIC_BASE_URL !== snapshot.endpoint ||
      Object.keys(env).some(
        (key) => /^(GOOGLE_|GCLOUD_|ANTHROPIC_VERTEX_|VERTEX_REGION_)/.test(key) && !!env[key],
      ) ||
      [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CONFIG_DIR',
        'MITZO_CLAUDE_EXPECTED_EMAIL',
        'CLOUD_ML_REGION',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_FOUNDRY',
      ].some((key) => !!env[key] && env[key] !== '0')
    )
      throw unavailable();
    const alternate =
      snapshot.authentication === 'bearer' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
    if (env[alternate]) throw unavailable();
    return snapshot;
  } catch (cause) {
    throw new AnthropicApiCredentialError(cause);
  }
}
/** Persist reference and managed version only. Secret reads stay in the controller. */
export class AnthropicApiCustody {
  private constructor(private readonly retained: Snapshot) {}
  static capture(env: Readonly<NodeJS.ProcessEnv>) {
    return new AnthropicApiCustody(observe(env));
  }
  static reopen(snapshot: Snapshot, env: Readonly<NodeJS.ProcessEnv>) {
    const custody = new AnthropicApiCustody(AnthropicApiCustodySchema.parse(snapshot));
    custody.assertCurrent(env);
    return custody;
  }
  snapshot(): Snapshot {
    return structuredClone(this.retained);
  }
  assertCurrent(env: Readonly<NodeJS.ProcessEnv>) {
    if (!isDeepStrictEqual(observe(env), this.retained)) throw unavailable();
  }
  private async read(signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      if (this.retained.credentialRef.service.startsWith('mitzo.openai.enrollment.')) {
        const authority = getConnectionsRuntime()?.openAIEnrollmentAuthority;
        const id = 'openai-' + this.retained.credentialVersion;
        if (
          !authority?.manages(id) ||
          this.retained.credentialRef.service !==
            'mitzo.openai.enrollment.' + this.retained.credentialVersion ||
          this.retained.credentialRef.account !== 'api-key'
        )
          throw unavailable();
        const value = await authority.resolveHostKey(id, signal);
        signal.throwIfAborted();
        return value;
      }
      const secret = await new KeychainRotationCredentials().read(
        this.retained.credentialRef,
        signal,
      );
      signal.throwIfAborted();
      if (!secret.managed || secret.version !== this.retained.credentialVersion)
        throw unavailable();
      return secret.value;
    } catch (cause) {
      if (!signal.aborted)
        log.warn('Anthropic API credentials unavailable', {
          stage: 'keychain',
          code: 'ANTHROPIC_CREDENTIAL_UNAVAILABLE',
        });
      throw new AnthropicApiCredentialError(cause);
    }
  }
  async verify(env: Readonly<NodeJS.ProcessEnv>, signal: AbortSignal) {
    this.assertCurrent(env);
    const value = await this.read(signal);
    const selected =
      this.retained.authentication === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
    if (env[selected] !== undefined && env[selected] !== value) throw unavailable();
    this.assertCurrent(env);
  }
  async inferenceEnvironment(env: Readonly<NodeJS.ProcessEnv>, signal: AbortSignal) {
    this.assertCurrent(env);
    const value = await this.read(signal);
    this.assertCurrent(env);
    return {
      ...env,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      [this.retained.authentication === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']:
        value,
    };
  }
}
