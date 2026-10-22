import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readBoundedFile } from './bounded-file-read.js';
import { SUPPORTED_CODEX_CLI_VERSION } from './codex-app-server-client.js';
import {
  reviewedConnectionsRuntimeImplementationRevision,
  reviewedHandlerSourceArtifacts,
} from './connections/reviewed-handler-artifacts.js';
import { OrdinaryLocalCodexTarget } from './ordinary-local-codex-capabilities.js';
import { measureHostCodexExecutable } from './frozen-host-codex-executable.js';
import type { FrozenHostCodexRuntimeObservation } from './frozen-host-codex-bootstrap.js';
import { registerWorkspaceRuntimeAuthorityPaths } from './workspace-runtime-private-paths.js';
import type { OrdinaryLocalCodexCapabilityCatalog } from './ordinary-local-codex-capabilities.js';

const unavailable = () => new Error('Host Codex runtime observation unavailable');
const Native = z.strictObject({
  version: z.literal(1),
  executablePath: z.string().max(4096).refine(isAbsolute),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export function ordinaryLocalCodexHostContractRevision(executableSha256: string): string {
  const codeClosure = createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(reviewedHandlerSourceArtifacts).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    )
    .digest('hex');
  return createHash('sha256')
    .update(
      JSON.stringify([
        'ordinary-local-codex-host-v1',
        reviewedConnectionsRuntimeImplementationRevision,
        codeClosure,
        SUPPORTED_CODEX_CLI_VERSION,
        executableSha256,
      ]),
    )
    .digest('hex');
}
export function readPrivateRuntimeSettings(path: string | undefined): unknown {
  let fd: number | undefined;
  try {
    if (!path || !isAbsolute(path) || realpathSync(path) !== path) throw unavailable();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.uid !== BigInt(process.getuid!()) ||
      stat.nlink !== 1n ||
      (stat.mode & 0o777n) !== 0o600n
    )
      throw unavailable();
    const bytes = readBoundedFile(fd, 65536);
    if (realpathSync(path) !== path) throw unavailable();
    for (const current of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })])
      for (const field of [
        'dev',
        'ino',
        'size',
        'mtimeNs',
        'ctimeNs',
        'uid',
        'mode',
        'nlink',
      ] as const)
        if (current[field] !== stat[field]) throw unavailable();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw unavailable();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read-only host/native observation from explicitly selected private operator
 * configuration. Host identity comes from the OS; native bytes are measured,
 * then their retained metadata is fenced. The source revision belongs to this
 * installed implementation and still requires accepted deployment qualification.
 * Configuration never establishes account readiness or grants runtime custody.
 */
export class OrdinaryLocalCodexHostRuntime {
  readonly #env: Readonly<NodeJS.ProcessEnv>;
  readonly #native: z.infer<typeof Native>;
  readonly #measurement: ReturnType<typeof measureHostCodexExecutable>;
  readonly #codeModeHost: ReturnType<typeof measureHostCodexExecutable>;
  readonly #target: OrdinaryLocalCodexTarget;
  constructor(env: Readonly<NodeJS.ProcessEnv> = process.env) {
    try {
      this.#env = { ...env };
      this.#native = Native.parse(
        readPrivateRuntimeSettings(this.#env.MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE),
      );
      this.#target = new OrdinaryLocalCodexTarget(
        readPrivateRuntimeSettings(this.#env.MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE),
      );
      this.#measurement = measureHostCodexExecutable(this.#native.executablePath);
      this.#codeModeHost = measureHostCodexExecutable(
        join(dirname(this.#native.executablePath), 'codex-code-mode-host'),
      );
      this.assertCurrentSync();
      const selectors = [
        this.#env.MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE!,
        this.#env.MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE!,
      ];
      registerWorkspaceRuntimeAuthorityPaths(
        [
          ...selectors,
          this.#native.executablePath,
          join(dirname(this.#native.executablePath), 'codex-code-mode-host'),
        ],
        selectors,
      );
    } catch {
      throw unavailable();
    }
  }
  target(): OrdinaryLocalCodexTarget {
    return new OrdinaryLocalCodexTarget(
      readPrivateRuntimeSettings(this.#env.MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE),
    );
  }
  /** Current measured host qualifies a retained identity without rewriting it. */
  continuationDeclaration(targetRevision: string) {
    this.assertCurrentSync();
    const target = this.target();
    if (!target.compatibleTargetRevisions(this.#measurement.sha256).includes(targetRevision))
      throw unavailable();
    return { ...target.admissionDeclaration(), targetRevision };
  }
  continuationConfiguration(catalog: OrdinaryLocalCodexCapabilityCatalog, targetRevision: string) {
    const declaration = this.continuationDeclaration(targetRevision);
    return {
      declaration,
      catalog: {
        inventory: () => catalog.inventory(),
        resolve: (input: unknown) => {
          const resolved = catalog.resolve(input);
          return resolved.status === 'compatible' &&
            resolved.binding.execution.targetId === declaration.targetId
            ? {
                ...resolved,
                binding: {
                  ...resolved.binding,
                  execution: { ...resolved.binding.execution, targetRevision },
                },
              }
            : resolved;
        },
      },
    };
  }
  assertCurrentSync(): void {
    const native = Native.parse(
      readPrivateRuntimeSettings(this.#env.MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE),
    );
    const original = this.#target.admissionDeclaration(),
      current = this.target().admissionDeclaration();
    if (
      native.executablePath !== this.#native.executablePath ||
      native.executableSha256 !== this.#native.executableSha256 ||
      this.#measurement.sha256 !== native.executableSha256 ||
      JSON.stringify(original) !== JSON.stringify(current) ||
      current.hostId !== hostname() ||
      current.runtimeContractRevision !==
        ordinaryLocalCodexHostContractRevision(native.executableSha256)
    )
      throw unavailable();
    this.#measurement.assertCurrent();
    this.#codeModeHost.assertCurrent();
  }
  async observe(): Promise<FrozenHostCodexRuntimeObservation> {
    try {
      this.assertCurrentSync();
      const declaration = this.#target.admissionDeclaration();
      return {
        hostId: hostname(),
        runtimeContractRevision: ordinaryLocalCodexHostContractRevision(
          this.#native.executableSha256,
        ),
        targetId: declaration.targetId,
        targetRevision: declaration.targetRevision,
        compatibleTargetRevisions: this.#target.compatibleTargetRevisions(this.#measurement.sha256),
        executablePath: this.#native.executablePath,
        executableSha256: this.#measurement.sha256,
      };
    } catch {
      throw unavailable();
    }
  }
}
