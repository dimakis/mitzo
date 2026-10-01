/** Trusted host comparisons; artifact stdout is data and never authority.
 * Uses the sealer's retained command/custody/journal rather than a scheduler. */
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalReviewJson } from './symposium-review-records.js';
import {
  SemanticCriterionDefinitionSchema,
  SemanticCriterionExecutionSchema,
  type SemanticCriterionDefinition,
} from './symposium-criterion-receipts.js';
import {
  ArtifactCommandTerminalNonzero,
  classifySemanticAttachedNonzero,
  type ArtifactPodmanCommand,
} from './symposium-artifact-host.js';
import {
  SemanticCidWitnessOwner,
  semanticCidWitnessDigest,
  type SemanticCidWitnessBinding,
} from './symposium-semantic-cid-witness.js';
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
const CAPS = new Set([
  'CAP_CHOWN',
  'CAP_DAC_OVERRIDE',
  'CAP_FOWNER',
  'CAP_FSETID',
  'CAP_KILL',
  'CAP_NET_BIND_SERVICE',
  'CAP_SETFCAP',
  'CAP_SETGID',
  'CAP_SETPCAP',
  'CAP_SETUID',
  'CAP_SYS_CHROOT',
]);
const CID = /^[a-f0-9]{64}$/;
const imageDigest = (image: string) => {
  const digest = image.replace(/^sha256:/, '');
  if (!CID.test(digest)) throw Error('Semantic image must be an exact digest');
  return digest;
};
const artifactPath = (deps: SemanticRunnerDependencies, path: string) =>
  deps.target +
  (deps.seal.repositoryPath === '.' ? '' : '/' + deps.seal.repositoryPath) +
  '/' +
  path;
const MAX_OUTPUT = 16384;
function exactMountOptions(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === expected.length &&
    value.every((option) => typeof option === 'string' && expected.includes(option))
  );
}
function exactReadonlyBinding(value: unknown, volume: string, target: string): boolean {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') return false;
  const parts = value[0].split(':');
  return (
    parts.length === 3 &&
    parts[0] === volume &&
    parts[1] === target &&
    exactMountOptions(parts[2].split(','), ['ro', 'rprivate', 'nosuid', 'nodev', 'rbind'])
  );
}

type Seal = {
  fenceId: string;
  custodyDigest: string;
  sessionId: string;
  repositoryPath: string;
  git: { commit: string; committedTreeDigest: string };
};
type Row = {
  job_id: string;
  fence_id: string;
  operation_id: string;
  kind: string;
  input_json: string;
  custody_digest: string;
  state: string;
  container_name: string;
  container_id: string | null;
  result_hash: string | null;
  receipt_json: string | null;
  helper_image: string | null;
  export_code_digest: string | null;
  cid_witness_json?: string | null;
};
type CaseReceipt = {
  id: string;
  status: 'passed' | 'mismatch' | 'malformed' | 'overflow' | 'nonzero' | 'missing' | 'timeout';
  stdoutCapturedBytes: number;
  stdoutCapturedSha256: string;
};
export type SemanticRunnerDependencies = {
  db: Database.Database;
  cidWitness?: SemanticCidWitnessOwner;
  command: ArtifactPodmanCommand;
  seal: Seal;
  volume: string;
  image: string;
  target: string;
  requireSeal(): Promise<Seal>;
  custody(): Promise<void>;
  checkFile(path: string, operationId: string): Promise<string | null>;
  withSnapshot(operation: () => void): void;
};
function compareOutput(id: string, output: string, expected: unknown): CaseReceipt {
  const bytes = Buffer.from(output);
  const base = {
    id,
    stdoutCapturedBytes: Math.min(bytes.length, MAX_OUTPUT),
    stdoutCapturedSha256: createHash('sha256').update(bytes.subarray(0, MAX_OUTPUT)).digest('hex'),
  };
  if (bytes.length > MAX_OUTPUT) return { ...base, status: 'overflow' };
  try {
    const value: unknown = JSON.parse(output);
    return {
      ...base,
      status: canonicalReviewJson(value) === canonicalReviewJson(expected) ? 'passed' : 'mismatch',
    };
  } catch {
    return { ...base, status: 'malformed' };
  }
}
async function inspectOwned(deps: SemanticRunnerDependencies, row: Row) {
  if (!row.container_id || !CID.test(row.container_id))
    throw Error('Semantic helper identity requires reconciliation');
  const values: unknown = JSON.parse(await deps.command(['inspect', row.container_id]));
  if (!Array.isArray(values) || values.length !== 1)
    throw Error('Semantic helper inspection changed');
  const c = values[0],
    h = c?.HostConfig;
  const selected = JSON.parse(row.input_json) as {
    input: { definition: SemanticCriterionDefinition };
  };
  const path = artifactPath(
    deps,
    SemanticCriterionDefinitionSchema.parse(selected.input.definition).path,
  );
  if (
    imageDigest(String(c?.Image ?? '')) !== imageDigest(deps.image) ||
    c.Config?.Tty !== false ||
    c.Config?.OpenStdin !== true ||
    JSON.stringify(c.Config?.Entrypoint) !== '["/usr/bin/python3"]' ||
    JSON.stringify(c.Config?.Cmd) !== JSON.stringify(['-I', '-B', path]) ||
    h?.CpuPeriod !== 100000 ||
    h?.CpuQuota !== 100000 ||
    h?.PidMode !== 'private' ||
    h?.UTSMode !== 'private' ||
    h?.IpcMode !== 'private' ||
    !['', 'private'].includes(h?.UsernsMode) ||
    !(h.PortBindings === null || JSON.stringify(h.PortBindings) === '{}') ||
    JSON.stringify(h.Tmpfs) !== '{}' ||
    !exactReadonlyBinding(h.Binds, deps.volume, deps.target)
  )
    throw Error('Semantic executable or namespaces changed');
  if (
    c?.Id !== row.container_id ||
    c.Name !== row.container_name ||
    c.ImageName !== deps.image ||
    c.Config?.User !== 'sandbox' ||
    c.Config?.Labels?.['mitzo.artifact-export-job'] !== row.job_id ||
    !h ||
    h.NetworkMode !== 'none' ||
    h.ReadonlyRootfs !== true ||
    h.Privileged !== false ||
    !Array.isArray(h.CapDrop) ||
    h.CapDrop.length !== 11 ||
    new Set(h.CapDrop).size !== 11 ||
    h.CapDrop.some((x: string) => !CAPS.has(x)) ||
    !Array.isArray(h.CapAdd) ||
    h.CapAdd.length ||
    !['["no-new-privileges"]', '["no-new-privileges=true"]'].includes(
      JSON.stringify(h.SecurityOpt),
    ) ||
    h.PidsLimit !== 32 ||
    h.Memory !== 268435456 ||
    h.NanoCpus !== 1000000000 ||
    !Array.isArray(c.Mounts) ||
    c.Mounts.length !== 1 ||
    c.Mounts[0].Type !== 'volume' ||
    c.Mounts[0].Name !== deps.volume ||
    c.Mounts[0].Driver !== 'local' ||
    c.Mounts[0].Mode !== '' ||
    c.Mounts[0].Propagation !== 'rprivate' ||
    !exactMountOptions(c.Mounts[0].Options, ['nosuid', 'nodev', 'rbind']) ||
    c.Mounts[0].Destination !== deps.target ||
    c.Mounts[0].RW !== false ||
    typeof c.State?.Running !== 'boolean'
  )
    throw Error('Semantic helper isolation changed');
  return c as { State: { Status?: string; Running: boolean; ExitCode: number } };
}
function witnessBinding(row: Row): SemanticCidWitnessBinding {
  if (!row.export_code_digest || !row.helper_image)
    throw Error('Semantic witness source unavailable');
  return {
    jobId: row.job_id,
    fenceId: row.fence_id,
    operationId: row.operation_id,
    inputJson: row.input_json,
    custodyDigest: row.custody_digest,
    codeDigest: row.export_code_digest,
    image: row.helper_image,
  };
}
/** Original private witness, never a name-based replacement or execution permit. */
async function recoverWitnessCid(deps: SemanticRunnerDependencies, row: Row, parent: Row) {
  if (row.container_id) return;
  if (!deps.cidWitness || !row.cid_witness_json || row.state !== 'create_uncertain')
    throw Error('Unknown semantic creation CID requires reconciliation');
  const manifest: unknown = JSON.parse(row.cid_witness_json);
  const cid = deps.cidWitness.read(manifest, witnessBinding(row));
  await deps.custody();
  deps.withSnapshot(() => {});
  await inspectOwned(deps, { ...row, container_id: cid });
  await deps.custody();
  deps.withSnapshot(() => {});
  if (deps.cidWitness.read(manifest, witnessBinding(row)) !== cid)
    throw Error('Original semantic witness changed');
  deps.db
    .transaction(() => {
      deps.withSnapshot(() => {});
      const current = deps.db
        .prepare('SELECT * FROM symposium_seal_export_jobs WHERE job_id=?')
        .get(row.job_id);
      const currentParent = deps.db
        .prepare('SELECT * FROM symposium_seal_export_jobs WHERE job_id=?')
        .get(parent.job_id);
      if (
        parent.state !== 'in_progress' ||
        canonicalReviewJson(current) !== canonicalReviewJson(row) ||
        canonicalReviewJson(currentParent) !== canonicalReviewJson(parent)
      )
        throw Error('Original semantic witness journal changed');
      if (
        deps.db
          .prepare(
            "UPDATE symposium_seal_export_jobs SET container_id=? WHERE job_id=? AND state='create_uncertain' AND container_id IS NULL AND cid_witness_json=?",
          )
          .run(cid, row.job_id, row.cid_witness_json).changes !== 1
      )
        throw Error('Original semantic witness CAS changed');
    })
    .immediate();
  row.container_id = cid;
}
async function removeOwned(deps: SemanticRunnerDependencies, row: Row) {
  const deadline = performance.now() + 30000,
    retained = deps.command;
  deps = {
    ...deps,
    command: (args, _max, input) => {
      const ms = Math.floor(Math.min(5000, deadline - performance.now()));
      if (ms < 1) throw Error('Semantic cleanup deadline requires reconciliation');
      return boundedCommand(retained, args, input, ms);
    },
  };
  await deps.custody();
  deps.withSnapshot(() => {});
  const c = await inspectOwned(deps, row);
  if (c.State.Running) await deps.command(['stop', '--time', '1', row.container_id!]);
  if ((await inspectOwned(deps, row)).State.Running)
    throw Error('Semantic helper stop requires reconciliation');
  await deps.custody();
  deps.withSnapshot(() => {});
  await deps.command(['rm', row.container_id!]);
  const census: unknown = JSON.parse(
    await deps.command(['ps', '--all', '--no-trunc', '--format', 'json']),
  );
  if (
    !Array.isArray(census) ||
    census.length > 128 ||
    census.some((c) => !CID.test(String(c?.Id ?? c?.ID ?? ''))) ||
    census.some((c) => (c.Id ?? c.ID) === row.container_id)
  )
    throw Error('Semantic helper removal requires reconciliation');
  deps.db
    .prepare("UPDATE symposium_seal_export_jobs SET state='removed' WHERE job_id=?")
    .run(row.job_id);
}
async function boundedCommand(
  command: ArtifactPodmanCommand,
  args: readonly string[],
  input: Buffer | undefined,
  timeoutMs: number,
  observe?: (text: string) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = performance.now() + timeoutMs;
  const pending = command(args, MAX_OUTPUT, input, timeoutMs).then(
    (text) => {
      observe?.(text);
      if (performance.now() >= deadline)
        throw Error('Semantic late command completion requires reconciliation');
      return text;
    },
    (error: unknown) => {
      // Rejected terminal callbacks must obey the same monotonic window. A late
      // typed nonzero is uncertainty, never a completed criterion case.
      if (performance.now() >= deadline)
        throw Error('Semantic late command failure requires reconciliation');
      throw error;
    },
  );
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error('Semantic command timeout requires reconciliation')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function runnerDigest() {
  return hash([
    runOwnedSemanticCriterion.toString(),
    reconcileOwnedSemanticCriterion.toString(),
    compareOutput.toString(),
    ArtifactCommandTerminalNonzero.toString(),
    classifySemanticAttachedNonzero.toString(),
    SemanticCidWitnessOwner.toString(),
    semanticCidWitnessDigest.toString(),
    semanticCidWitnessDigest(),
    witnessBinding.toString(),
    recoverWitnessCid.toString(),
    inspectOwned.toString(),
    removeOwned.toString(),
    boundedCommand.toString(),
    inspectSemanticCleanupOwners.toString(),
    artifactPath.toString(),
    imageDigest.toString(),
    exactReadonlyBinding.toString(),
    exactMountOptions.toString(),
    [...CAPS],
    MAX_OUTPUT,
    canonicalReviewJson.toString(),
  ]);
}
export async function runOwnedSemanticCriterion(
  deps: SemanticRunnerDependencies,
  raw: { fenceId: string; operationId: string; definition: SemanticCriterionDefinition },
  signal: AbortSignal,
) {
  const definition = SemanticCriterionDefinitionSchema.parse(raw.definition);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw.operationId) ||
    raw.fenceId !== deps.seal.fenceId
  )
    throw Error('Semantic operation identity invalid');
  const input = { fenceId: raw.fenceId, operationId: raw.operationId, definition };
  const selection = canonicalReviewJson(input),
    definitionDigest = hash(definition),
    codeDigest = runnerDigest();
  const sealDigest = hash(deps.seal);
  const current = async () => {
    signal.throwIfAborted();
    await deps.custody();
    if (canonicalReviewJson(await deps.requireSeal()) !== canonicalReviewJson(deps.seal))
      throw Error('Semantic physical seal changed');
    deps.withSnapshot(() => {});
    signal.throwIfAborted();
  };
  await current();
  const existing = deps.db
    .prepare('SELECT * FROM symposium_seal_export_jobs WHERE operation_id=?')
    .all(input.operationId) as Row[];
  if (existing.length) {
    const row = existing[0];
    if (
      existing.length !== 1 ||
      row.kind !== 'semantic' ||
      row.input_json !== selection ||
      row.fence_id !== input.fenceId ||
      row.custody_digest !== deps.seal.custodyDigest ||
      row.helper_image !== deps.image ||
      row.export_code_digest !== codeDigest
    )
      throw Error('Semantic original operation binding changed');
    if (row.state !== 'complete' || !row.receipt_json)
      throw Error('Semantic original operation requires reconciliation');
    const receipt = SemanticCriterionExecutionSchema.parse(JSON.parse(row.receipt_json));
    if (
      hash(receipt) !== row.result_hash ||
      receipt.executionId !== row.job_id ||
      receipt.definitionDigest !== definitionDigest ||
      receipt.sealDigest !== sealDigest ||
      receipt.sealFenceId !== input.fenceId ||
      receipt.artifactRevision !== deps.seal.git.commit ||
      receipt.artifactHash !== deps.seal.git.committedTreeDigest ||
      receipt.cases.length !== definition.cases.length ||
      receipt.cases.some((c, i) => c.id !== definition.cases[i].id)
    )
      throw Error('Retained semantic receipt changed');
    return receipt;
  }
  const source = await deps.checkFile(definition.path, 'semantic-source-' + hash(input));
  await current();
  const jobId = randomUUID(),
    name = 'mitzo-semantic-' + jobId;
  deps.db
    .transaction(() => {
      deps.withSnapshot(() => {});
      if (
        deps.db
          .prepare('SELECT 1 FROM symposium_seal_export_jobs WHERE operation_id=?')
          .get(input.operationId) ||
        deps.db
          .prepare(
            "SELECT 1 FROM symposium_seal_export_jobs WHERE fence_id=? AND state NOT IN ('complete','failed_cleaned','not_dispatched')",
          )
          .get(input.fenceId)
      )
        throw Error('Semantic original operation requires reconciliation');
      deps.db
        .prepare(
          'INSERT INTO symposium_seal_export_jobs(job_id,fence_id,operation_id,kind,input_json,custody_digest,state,container_name,helper_image,export_code_digest) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          jobId,
          input.fenceId,
          input.operationId,
          'semantic',
          selection,
          deps.seal.custodyDigest,
          'in_progress',
          name,
          deps.image,
          codeDigest,
        );
    })
    .immediate();
  const results: CaseReceipt[] = [];
  const deadline = performance.now() + 45000;
  const remaining = (maximum = 5000) => {
    const ms = Math.floor(Math.min(maximum, deadline - performance.now()));
    if (ms < 1) throw Error('Semantic aggregate deadline requires reconciliation');
    return ms;
  };
  const executionDeps = {
    ...deps,
    command: (args: readonly string[], _max?: number, input?: Buffer) =>
      boundedCommand(deps.command, args, input, remaining(5000)),
  };
  for (const item of definition.cases) {
    if (source === null) {
      results.push({
        id: item.id,
        status: 'missing',
        stdoutCapturedBytes: 0,
        stdoutCapturedSha256: createHash('sha256').update('').digest('hex'),
      });
      continue;
    }
    await current();
    if (performance.now() >= deadline) throw Error('Semantic time bound requires reconciliation');
    const id = randomUUID(),
      caseName = 'mitzo-semantic-' + id;
    const row: Row = {
      job_id: id,
      fence_id: input.fenceId,
      operation_id: 'semantic-case-' + hash({ input, id: item.id }),
      kind: 'semantic_case',
      input_json: canonicalReviewJson({ input, caseId: item.id, sourceSha256: source }),
      custody_digest: deps.seal.custodyDigest,
      state: 'create_uncertain',
      container_name: caseName,
      container_id: null,
      result_hash: null,
      receipt_json: null,
      helper_image: deps.image,
      export_code_digest: codeDigest,
    };
    deps.db
      .transaction(() => {
        deps.withSnapshot(() => {});
        const original = deps.db
          .prepare(
            "SELECT * FROM symposium_seal_export_jobs WHERE job_id=? AND state='in_progress'",
          )
          .get(jobId) as Row | undefined;
        if (
          !original ||
          original.input_json !== selection ||
          original.fence_id !== input.fenceId ||
          original.custody_digest !== deps.seal.custodyDigest ||
          original.helper_image !== deps.image ||
          original.export_code_digest !== codeDigest
        )
          throw Error('Semantic original operation requires reconciliation');
        if (
          deps.db
            .prepare('SELECT 1 FROM symposium_seal_export_jobs WHERE operation_id=?')
            .get(row.operation_id)
        )
          throw Error('Semantic case requires original reconciliation');
        deps.db
          .prepare(
            'INSERT INTO symposium_seal_export_jobs(job_id,fence_id,operation_id,kind,input_json,custody_digest,state,container_name,helper_image,export_code_digest) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            row.job_id,
            row.fence_id,
            row.operation_id,
            row.kind,
            row.input_json,
            row.custody_digest,
            row.state,
            row.container_name,
            row.helper_image,
            row.export_code_digest,
          );
      })
      .immediate();
    const active = (state: string) => {
      const parent = deps.db
        .prepare(
          "SELECT 1 FROM symposium_seal_export_jobs WHERE job_id=? AND state='in_progress' AND input_json=? AND custody_digest=? AND export_code_digest=?",
        )
        .get(jobId, selection, deps.seal.custodyDigest, codeDigest);
      const child = deps.db
        .prepare('SELECT state,container_id FROM symposium_seal_export_jobs WHERE job_id=?')
        .get(id) as { state: string; container_id: string | null } | undefined;
      if (!parent || child?.state !== state || child.container_id !== row.container_id)
        throw Error('Semantic original operation requires reconciliation');
    };
    let removed = false;
    try {
      signal.throwIfAborted();
      await deps.custody();
      deps.withSnapshot(() => {});
      active('create_uncertain');
      let witnessPath: string | undefined;
      if (deps.cidWitness) {
        const originalRow = deps.db
          .prepare('SELECT * FROM symposium_seal_export_jobs WHERE job_id=?')
          .get(id) as Row;
        if (
          originalRow.input_json !== row.input_json ||
          originalRow.custody_digest !== row.custody_digest ||
          originalRow.export_code_digest !== codeDigest ||
          originalRow.container_name !== row.container_name
        )
          throw Error('Original semantic witness preparation binding changed');
        const manifest = deps.cidWitness.prepare(witnessBinding(row));
        row.cid_witness_json = canonicalReviewJson(manifest);
        deps.db
          .transaction(() => {
            deps.withSnapshot(() => {});
            active('create_uncertain');
            if (
              canonicalReviewJson(
                deps.db.prepare('SELECT * FROM symposium_seal_export_jobs WHERE job_id=?').get(id),
              ) !== canonicalReviewJson(originalRow)
            )
              throw Error('Original semantic witness preparation snapshot changed');
            if (
              deps.db
                .prepare(
                  "UPDATE symposium_seal_export_jobs SET cid_witness_json=? WHERE job_id=? AND state='create_uncertain' AND container_id IS NULL AND cid_witness_json IS NULL",
                )
                .run(row.cid_witness_json, id).changes !== 1
            )
              throw Error('Original semantic witness preparation changed');
          })
          .immediate();
        witnessPath = manifest.path;
      }
      const path = artifactPath(deps, definition.path);
      const createdArgs = [
        'create',
        ...(witnessPath ? ['--cidfile', witnessPath] : []),
        '--interactive',
        '--pull=never',
        '--name',
        caseName,
        '--label',
        'mitzo.artifact-export-job=' + id,
        '--network=none',
        '--pid=private',
        '--ipc=private',
        '--uts=private',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user',
        'sandbox',
        '--pids-limit=32',
        '--memory=256m',
        '--cpus=1',
        '--mount',
        `type=volume,src=${deps.volume},dst=${deps.target},readonly`,
        '--entrypoint=/usr/bin/python3',
        deps.image,
        '-I',
        '-B',
        path,
      ];
      // Record late known-CID observations even when the aggregate wait has already
      // expired. They authorize original-ID reconciliation, never favorable evidence.
      await boundedCommand(deps.command, createdArgs, undefined, remaining(), (text) => {
        const cid = text.trim();
        if (!CID.test(cid)) throw Error('Semantic creation outcome requires reconciliation');
        row.container_id = cid;
        deps.db
          .prepare(
            "UPDATE symposium_seal_export_jobs SET state=CASE WHEN state='create_uncertain' THEN 'created' ELSE state END,container_id=? WHERE job_id=? AND container_id IS NULL",
          )
          .run(cid, id);
      });
      const cid = row.container_id!;
      await inspectOwned(executionDeps, row);
      signal.throwIfAborted();
      await deps.custody();
      deps.withSnapshot(() => {});
      active('created');
      deps.db
        .prepare("UPDATE symposium_seal_export_jobs SET state='start_uncertain' WHERE job_id=?")
        .run(id);
      let output: string;
      let attachedNonzero: ArtifactCommandTerminalNonzero | undefined;
      try {
        output = await executionDeps.command(
          ['start', '--attach', '--interactive', cid],
          MAX_OUTPUT,
          Buffer.from(JSON.stringify(item.input) + '\n'),
        );
      } catch (error) {
        if (
          !(error instanceof ArtifactCommandTerminalNonzero) ||
          error.containerId !== cid ||
          error.stdoutCapturedBytes > MAX_OUTPUT
        )
          throw error;
        signal.throwIfAborted();
        await deps.custody();
        deps.withSnapshot(() => {});
        active('start_uncertain');
        attachedNonzero = error;
        output = error.capturedStdout();
      }
      const terminal = await inspectOwned(executionDeps, row);
      if (terminal.State.Running || !Number.isInteger(terminal.State.ExitCode))
        throw Error('Semantic terminal result requires reconciliation');
      if (
        attachedNonzero &&
        (!['exited', 'stopped'].includes(terminal.State.Status ?? '') ||
          terminal.State.ExitCode !== attachedNonzero.exitCode ||
          terminal.State.ExitCode < 1 ||
          terminal.State.ExitCode > 255)
      )
        throw Error('Semantic nonzero terminal result requires reconciliation');
      const checked =
        terminal.State.ExitCode === 0
          ? compareOutput(item.id, output, item.expected)
          : {
              id: item.id,
              status: 'nonzero' as const,
              stdoutCapturedBytes: Math.min(MAX_OUTPUT, Buffer.byteLength(output)),
              stdoutCapturedSha256: createHash('sha256')
                .update(Buffer.from(output).subarray(0, MAX_OUTPUT))
                .digest('hex'),
            };
      deps.db
        .prepare(
          "UPDATE symposium_seal_export_jobs SET state='terminal',receipt_json=?,result_hash=? WHERE job_id=?",
        )
        .run(canonicalReviewJson(checked), hash(checked), id);
      await removeOwned(deps, row);
      removed = true;
      await current();
      deps.db
        .prepare(
          "UPDATE symposium_seal_export_jobs SET state='complete' WHERE job_id=? AND state='removed'",
        )
        .run(id);
      results.push(checked);
    } catch {
      if (row.container_id && !removed) {
        try {
          await removeOwned(deps, row);
        } catch {
          /* Exact pending row remains; unknown ownership never signals. */
        }
      }
      // Artifact output and driver errors may contain private data. Never expose them.
      throw Error('Semantic original operation requires reconciliation');
    }
  }
  await current();
  const receipt = SemanticCriterionExecutionSchema.parse({
    kind: 'python-json-cases',
    executionId: jobId,
    sealFenceId: input.fenceId,
    sealDigest,
    definitionDigest,
    artifactRevision: deps.seal.git.commit,
    artifactHash: deps.seal.git.committedTreeDigest,
    cases: results,
    completedAt: Date.now(),
  });
  deps.db
    .transaction(() => {
      deps.withSnapshot(() => {});
      const updated = deps.db
        .prepare(
          "UPDATE symposium_seal_export_jobs SET state='complete',receipt_json=?,result_hash=? WHERE job_id=? AND state='in_progress'",
        )
        .run(canonicalReviewJson(receipt), hash(receipt), jobId);
      if (updated.changes !== 1) throw Error('Semantic parent receipt changed');
    })
    .immediate();
  return receipt;
}

/** Retire only helpers of the original semantic operation. This is not retry or
 * favorable semantic evidence; unknown creation absence remains unresolved. */
export async function reconcileOwnedSemanticCriterion(
  deps: SemanticRunnerDependencies,
  raw: { fenceId: string; operationId: string; definition: SemanticCriterionDefinition },
  signal: AbortSignal,
) {
  const definition = SemanticCriterionDefinitionSchema.parse(raw.definition);
  const input = { fenceId: raw.fenceId, operationId: raw.operationId, definition };
  signal.throwIfAborted();
  await deps.custody();
  if (
    raw.fenceId !== deps.seal.fenceId ||
    canonicalReviewJson(await deps.requireSeal()) !== canonicalReviewJson(deps.seal)
  )
    throw Error('Semantic reconciliation seal changed');
  const parents = deps.db
    .prepare('SELECT * FROM symposium_seal_export_jobs WHERE operation_id=?')
    .all(input.operationId) as Row[];
  if (parents.length !== 1) throw Error('Original semantic operation unavailable');
  const parent = parents[0];
  if (
    parent.kind !== 'semantic' ||
    parent.input_json !== canonicalReviewJson(input) ||
    parent.fence_id !== input.fenceId ||
    parent.custody_digest !== deps.seal.custodyDigest ||
    parent.helper_image !== deps.image ||
    parent.export_code_digest !== runnerDigest()
  )
    throw Error('Original semantic operation binding changed');
  if (parent.state === 'complete') return { state: 'complete', retryAllowed: false };
  if (parent.state === 'failed_cleaned') {
    const receipt = JSON.parse(parent.receipt_json ?? 'null');
    if (hash(receipt) !== parent.result_hash)
      throw Error('Semantic reconciliation receipt changed');
    return receipt as { state: 'failed_cleaned'; retryAllowed: false };
  }
  const cleaned: string[] = [];
  const caseOperations = definition.cases.map(
    (item) => 'semantic-case-' + hash({ input, id: item.id }),
  );
  // Snapshot every selected case before asynchronous ownership/cleanup work.
  // Final retirement must not overlook a case added during the last seal await.
  const enumerated = caseOperations.map(
    (operation) =>
      deps.db
        .prepare('SELECT * FROM symposium_seal_export_jobs WHERE operation_id=?')
        .all(operation) as Row[],
  );
  const cleanedSnapshot = new Map<string, string>();
  for (const [index, item] of definition.cases.entries()) {
    const rows = enumerated[index];
    if (!rows.length) continue;
    if (rows.length !== 1) throw Error('Semantic case journal changed');
    const row = rows[0];
    const retained = JSON.parse(row.input_json) as { sourceSha256: string };
    if (
      row.kind !== 'semantic_case' ||
      row.fence_id !== input.fenceId ||
      row.custody_digest !== deps.seal.custodyDigest ||
      row.helper_image !== deps.image ||
      row.export_code_digest !== runnerDigest() ||
      row.container_name !== 'mitzo-semantic-' + row.job_id ||
      !CID.test(retained.sourceSha256) ||
      row.input_json !==
        canonicalReviewJson({ input, caseId: item.id, sourceSha256: retained.sourceSha256 })
    )
      throw Error('Semantic case binding changed');
    signal.throwIfAborted();
    await deps.custody();
    deps.withSnapshot(() => {});
    const census = async () => {
      signal.throwIfAborted();
      await deps.custody();
      deps.withSnapshot(() => {});
      const current: unknown = JSON.parse(
        await deps.command(['ps', '--all', '--no-trunc', '--format', 'json']),
      );
      signal.throwIfAborted();
      await deps.custody();
      deps.withSnapshot(() => {});
      if (
        !Array.isArray(current) ||
        current.length > 128 ||
        current.some((c) => !CID.test(String(c?.Id ?? c?.ID ?? ''))) ||
        current.some(
          (c) =>
            row.container_id &&
            Array.isArray(c?.Names) &&
            c.Names.includes(row.container_name) &&
            (c.Id ?? c.ID) !== row.container_id,
        )
      )
        throw Error('Semantic census unavailable or original name replaced');
      return current;
    };
    // Creation may finish while the original census is in flight. A recovered
    // witness must never turn that earlier snapshot into an absence proof.
    let current = await census();
    if (!row.container_id) {
      await recoverWitnessCid(deps, row, parent);
      current = await census();
    }
    if (current.some((c) => (c.Id ?? c.ID) === row.container_id)) await removeOwned(deps, row);
    if ((await census()).some((c) => (c.Id ?? c.ID) === row.container_id))
      throw Error('Original semantic helper absence requires reconciliation');
    deps.db
      .prepare(
        "UPDATE symposium_seal_export_jobs SET state='failed_cleaned' WHERE job_id=? AND state!='complete'",
      )
      .run(row.job_id);
    const after = deps.db
      .prepare('SELECT * FROM symposium_seal_export_jobs WHERE job_id=?')
      .get(row.job_id) as Row | undefined;
    if (!after || !['complete', 'failed_cleaned'].includes(after.state))
      throw Error('Semantic case cleanup state changed');
    cleanedSnapshot.set(row.operation_id, canonicalReviewJson(after));
    cleaned.push(row.container_id!);
  }
  signal.throwIfAborted();
  await deps.custody();
  if (canonicalReviewJson(await deps.requireSeal()) !== canonicalReviewJson(deps.seal))
    throw Error('Semantic reconciliation custody changed');
  const receipt = {
    operationId: input.operationId,
    state: 'failed_cleaned' as const,
    retryAllowed: false as const,
    originalOutcome: 'uncertain',
    retiredContainerIds: cleaned,
  };
  deps.db
    .transaction(() => {
      deps.withSnapshot(() => {});
      const currentParent = deps.db
        .prepare('SELECT * FROM symposium_seal_export_jobs WHERE job_id=?')
        .get(parent.job_id);
      if (!currentParent || canonicalReviewJson(currentParent) !== canonicalReviewJson(parent))
        throw Error('Semantic original cleanup parent changed');
      const unfinished = deps.db
        .prepare(
          "SELECT job_id FROM symposium_seal_export_jobs WHERE fence_id=? AND state NOT IN ('complete','failed_cleaned','not_dispatched')",
        )
        .all(input.fenceId) as { job_id: string }[];
      if (unfinished.some((row) => row.job_id !== parent.job_id))
        throw Error('Semantic unfinished case or concurrent operation blocks final cleanup');
      for (const operation of caseOperations) {
        const current = deps.db
          .prepare('SELECT * FROM symposium_seal_export_jobs WHERE operation_id=?')
          .all(operation) as Row[];
        const expected = cleanedSnapshot.get(operation);
        if (
          expected === undefined
            ? current.length !== 0
            : current.length !== 1 ||
              !['complete', 'failed_cleaned'].includes(current[0].state) ||
              canonicalReviewJson(current[0]) !== expected
        )
          throw Error('Semantic final case membership or cleanup state changed');
      }
      const retired = deps.db
        .prepare(
          "UPDATE symposium_seal_export_jobs SET state='failed_cleaned',receipt_json=?,result_hash=? WHERE job_id=? AND state='in_progress'",
        )
        .run(canonicalReviewJson(receipt), hash(receipt), parent.job_id);
      if (retired.changes !== 1) throw Error('Original semantic cleanup disposition changed');
    })
    .immediate();
  return receipt;
}

/** Cleanup-only qualification. No receipt/admission caller can use these IDs. */
export async function inspectSemanticCleanupOwners(
  deps: SemanticRunnerDependencies,
  raw: { fenceId: string; operationId: string; definition: SemanticCriterionDefinition },
) {
  const definition = SemanticCriterionDefinitionSchema.parse(raw.definition),
    input = { ...raw, definition };
  const parents = deps.db
    .prepare('SELECT * FROM symposium_seal_export_jobs WHERE operation_id=?')
    .all(input.operationId) as Row[];
  if (parents.length !== 1) throw Error('Original semantic cleanup parent unavailable');
  const parent = parents[0];
  if (
    parent.kind !== 'semantic' ||
    parent.input_json !== canonicalReviewJson(input) ||
    parent.fence_id !== deps.seal.fenceId ||
    parent.custody_digest !== deps.seal.custodyDigest ||
    parent.helper_image !== deps.image ||
    parent.export_code_digest !== runnerDigest()
  )
    throw Error('Original semantic cleanup binding changed');
  if (parent.state !== 'in_progress') {
    if (
      deps.db
        .prepare(
          "SELECT 1 FROM symposium_seal_export_jobs WHERE fence_id=? AND state NOT IN ('complete','failed_cleaned','not_dispatched')",
        )
        .get(input.fenceId)
    )
      throw Error('Concurrent artifact operation blocks cleanup');
    return new Set<string>();
  }
  const selected = new Set([parent.job_id]),
    allowed = new Set<string>();
  const census: unknown = JSON.parse(
    await deps.command(['ps', '--all', '--no-trunc', '--format', 'json']),
  );
  if (
    !Array.isArray(census) ||
    census.length > 128 ||
    census.some((c) => !CID.test(String(c?.Id ?? c?.ID ?? '')))
  )
    throw Error('Semantic cleanup census unavailable');
  for (const item of definition.cases) {
    const rows = deps.db
      .prepare('SELECT * FROM symposium_seal_export_jobs WHERE operation_id=?')
      .all('semantic-case-' + hash({ input, id: item.id })) as Row[];
    if (!rows.length) continue;
    if (rows.length !== 1) throw Error('Semantic cleanup journal changed');
    const row = rows[0];
    const retained = JSON.parse(row.input_json) as { sourceSha256: string };
    if (
      row.kind !== 'semantic_case' ||
      row.fence_id !== input.fenceId ||
      row.custody_digest !== deps.seal.custodyDigest ||
      row.helper_image !== deps.image ||
      row.export_code_digest !== runnerDigest() ||
      row.container_name !== 'mitzo-semantic-' + row.job_id ||
      !CID.test(retained.sourceSha256) ||
      row.input_json !==
        canonicalReviewJson({ input, caseId: item.id, sourceSha256: retained.sourceSha256 }) ||
      (row.container_id !== null && !CID.test(row.container_id))
    )
      throw Error('Known original semantic cleanup identity unavailable');
    if (!row.container_id) await recoverWitnessCid(deps, row, parent);
    selected.add(row.job_id);
    if (census.some((c) => (c.Id ?? c.ID) === row.container_id)) {
      await deps.custody();
      await inspectOwned(deps, row);
      allowed.add(row.container_id!);
    }
  }
  const unfinished = deps.db
    .prepare(
      "SELECT job_id FROM symposium_seal_export_jobs WHERE fence_id=? AND state NOT IN ('complete','failed_cleaned','not_dispatched')",
    )
    .all(input.fenceId) as { job_id: string }[];
  if (unfinished.some((row) => !selected.has(row.job_id)))
    throw Error('Unrelated artifact operation blocks cleanup');
  return allowed;
}

const CheckJournalState = z.enum([
  'in_progress',
  'create_uncertain',
  'created',
  'start_uncertain',
  'terminal',
  'removed',
  'complete',
  'failed_cleaned',
  'not_dispatched',
  'not_journaled',
]);
export const SemanticCheckStateReportSchema = z.strictObject({
  kind: z.literal('quarantined-check-state'),
  nextAction: z.literal('retain-original-operation-for-operator-disposition'),
  operationId: z.string().min(1).max(500),
  fenceId: z.string().min(1).max(500),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  parentState: z.enum(['in_progress', 'complete', 'failed_cleaned']),
  sourceCompatible: z.boolean(),
  cases: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(500),
        state: CheckJournalState,
        originalCidRetained: z.boolean(),
        witnessManifestRetained: z.boolean(),
      }),
    )
    .min(1)
    .max(8),
  retryAllowed: z.literal(false),
  executionAuthorized: z.literal(false),
  cleanupConfirmed: z.literal(false),
  semanticEvidenceAllowed: z.literal(false),
});
export type SemanticCheckStateReport = z.infer<typeof SemanticCheckStateReportSchema>;
/** Journal observation only. No process census, witness read, cleanup or evidence authority. */
export function inspectOwnedSemanticCheckState(
  deps: Pick<SemanticRunnerDependencies, 'db' | 'seal' | 'image' | 'withSnapshot'> & {
    sealSourceCompatible?: boolean;
  },
  raw: { fenceId: string; operationId: string; definition: SemanticCriterionDefinition },
  assertCurrent: () => void,
): SemanticCheckStateReport {
  const input = { ...raw, definition: SemanticCriterionDefinitionSchema.parse(raw.definition) };
  const states = new Set([
    'in_progress',
    'create_uncertain',
    'created',
    'start_uncertain',
    'terminal',
    'removed',
    'complete',
    'failed_cleaned',
    'not_dispatched',
  ]);
  const current = () => {
    assertCurrent();
    deps.withSnapshot(() => {});
  };
  current();
  const report = deps.db.transaction(() => {
    current();
    const parents = deps.db
      .prepare('SELECT * FROM symposium_seal_export_jobs WHERE operation_id=?')
      .all(input.operationId) as Row[];
    if (parents.length !== 1) throw Error('Original semantic check journal unavailable');
    const parent = parents[0];
    if (
      parent.kind !== 'semantic' ||
      parent.input_json !== canonicalReviewJson(input) ||
      parent.fence_id !== input.fenceId ||
      input.fenceId !== deps.seal.fenceId ||
      parent.custody_digest !== deps.seal.custodyDigest ||
      typeof parent.helper_image !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(parent.helper_image) ||
      !parent.export_code_digest ||
      !CID.test(parent.export_code_digest) ||
      !['in_progress', 'complete', 'failed_cleaned'].includes(parent.state)
    )
      throw Error('Original semantic check binding changed');
    const cases = input.definition.cases.map((item) => {
      const rows = deps.db
        .prepare('SELECT * FROM symposium_seal_export_jobs WHERE operation_id=?')
        .all('semantic-case-' + hash({ input, id: item.id })) as Row[];
      if (!rows.length)
        return {
          id: item.id,
          state: 'not_journaled',
          originalCidRetained: false,
          witnessManifestRetained: false,
        };
      if (rows.length !== 1) throw Error('Original semantic case journal ambiguous');
      const row = rows[0];
      const retained = JSON.parse(row.input_json) as { sourceSha256?: unknown };
      if (
        row.kind !== 'semantic_case' ||
        row.fence_id !== input.fenceId ||
        row.custody_digest !== parent.custody_digest ||
        row.helper_image !== parent.helper_image ||
        row.export_code_digest !== parent.export_code_digest ||
        row.container_name !== 'mitzo-semantic-' + row.job_id ||
        typeof retained.sourceSha256 !== 'string' ||
        !CID.test(retained.sourceSha256) ||
        row.input_json !==
          canonicalReviewJson({ input, caseId: item.id, sourceSha256: retained.sourceSha256 }) ||
        !states.has(row.state) ||
        (row.container_id !== null && !CID.test(row.container_id))
      )
        throw Error('Original semantic case binding changed');
      return {
        id: item.id,
        state: row.state,
        originalCidRetained: row.container_id !== null,
        witnessManifestRetained:
          typeof row.cid_witness_json === 'string' && row.cid_witness_json.length > 0,
      };
    });
    current();
    return {
      kind: 'quarantined-check-state' as const,
      nextAction: 'retain-original-operation-for-operator-disposition' as const,
      operationId: input.operationId,
      fenceId: input.fenceId,
      definitionDigest: hash(input.definition),
      parentState: parent.state,
      sourceCompatible:
        deps.sealSourceCompatible !== false &&
        parent.helper_image === deps.image &&
        parent.export_code_digest === runnerDigest(),
      cases,
      retryAllowed: false as const,
      executionAuthorized: false as const,
      cleanupConfirmed: false as const,
      semanticEvidenceAllowed: false as const,
    };
  })();
  current();
  return SemanticCheckStateReportSchema.parse(report);
}
