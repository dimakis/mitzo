import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { TelosSourcePacketSchema } from '@mitzo/protocol';
import type { TelosWorkSourceSnapshot } from '@mitzo/protocol';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import { captureLocalArtifactFile } from './openshell-artifact-reader.js';
import { MAX_TELOS_ARTIFACT_BYTES, type TelosArtifactStore } from './telos-artifact-store.js';
import { TelosSaveArtifactInput, TelosReadArtifactInput } from './telos-artifact-tools.js';
import type { TelosWorkStore } from './telos-work-store.js';
import type { TelosSourceCapture } from './telos-source-capture.js';
import type { TelosSourceApprovalStore } from './telos-source-approval-store.js';
import type { TelosToolResult } from './telos-tool.js';

type Name = 'TelosSaveArtifact' | 'TelosReadArtifact';
export interface NativeTelosArtifactOwners {
  context: NativeHostToolContext;
  artifacts: TelosArtifactStore;
  work: TelosWorkStore;
  sources?: TelosSourceCapture;
  approvals?: TelosSourceApprovalStore;
  /** The existing host permission owner must request an actual once decision. */
  approve(
    name: Name,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult>;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function unavailable(): never {
  throw Error('Original artifact operation unavailable');
}
const result = (artifact: unknown): TelosToolResult => ({
  content: JSON.stringify({ ok: true, artifact }),
  isError: false,
});

/** Bounded operations inside the original signed native callback. The context,
 * permission, canonical store and source owners retain their existing authority. */
export async function executeNativeTelosArtifactOperation(
  owners: NativeTelosArtifactOwners,
  name: Name,
  rawOriginal: unknown,
): Promise<TelosToolResult> {
  try {
    const { context: ctx, artifacts, work } = owners;
    const current = () => {
      ctx.signal.throwIfAborted();
      const renewed: unknown = ctx.assertCurrentSync();
      if (renewed !== undefined) {
        void Promise.resolve(renewed).catch(() => {});
        unavailable();
      }
      if (ctx.toolName !== name || ctx.requestHash !== hash(JSON.stringify(rawOriginal)))
        unavailable();
      ctx.signal.throwIfAborted();
    };
    const renew = async () => {
      current();
      await ctx.assertCurrent();
      current();
    };
    const actor = { kind: 'operator' as const, id: ctx.operatorId };
    const permit = async (input: Record<string, unknown>) => {
      current();
      const permission = await owners.approve(name, structuredClone(input), ctx.signal);
      await renew();
      if (permission.behavior !== 'allow' || !isDeepStrictEqual(permission.updatedInput, input))
        unavailable();
    };
    current();
    if (name === 'TelosSaveArtifact') {
      const input = TelosSaveArtifactInput.parse(rawOriginal);
      const inputHash = hash(JSON.stringify(input));
      const eligible = () => {
        if (ctx.selectedRole && ctx.selectedRole.itemId !== input.itemId) unavailable();
        work.read(input.itemId, actor);
        if (!artifacts.userUploadAllowed(input.itemId)) unavailable();
      };
      eligible();
      current();
      // Exact known receipts precede mutable workspace reads and another prompt.
      const receipt = artifacts.retryReceipt(ctx.conversationId, input.requestId, inputHash);
      if (receipt) return result(receipt);
      const file =
        input.path === undefined
          ? undefined
          : await captureLocalArtifactFile(
              ctx.workspace.directory,
              input.path,
              current,
              ctx.signal,
            );
      const bytes = file?.bytes ?? Buffer.from(input.content!, 'utf8');
      if (bytes.length > MAX_TELOS_ARTIFACT_BYTES) unavailable();
      await permit(input);
      const artifact = artifacts.saveGuarded(
        {
          itemId: input.itemId,
          filename: input.filename,
          title: input.title,
          bytes,
          sourcePath: file?.path,
          sessionId: ctx.conversationId,
          requestId: input.requestId,
          requestInputHash: inputHash,
        },
        () => {
          current();
          eligible();
          file?.assertCurrentSync();
        },
      );
      // The owner returned an actual COMMIT acknowledgement. Do not turn it into
      // uncertainty by awaiting or renewing authority after the effect.
      return result(artifact);
    }
    if (name !== 'TelosReadArtifact') unavailable();
    const input = TelosReadArtifactInput.parse(rawOriginal);
    if (input.revision === undefined) unavailable();
    const revision = input.revision;
    const selected: Array<{
      itemId: string;
      pin: TelosWorkSourceSnapshot['artifacts'][number];
      source?: TelosWorkSourceSnapshot;
    }> = [];
    const role = ctx.selectedRole;
    if (role) {
      for (const pin of role.artifacts) selected.push({ itemId: role.itemId, pin });
      for (const source of role.sources)
        for (const pin of source.artifacts) selected.push({ itemId: role.itemId, pin, source });
    }
    selected.push(
      ...(owners.approvals?.approvedArtifactSelection(
        ctx.conversationId,
        ctx.operatorId,
        input.id,
        revision,
      ) ?? []),
    );
    const matches = structuredClone(
      selected.filter(({ pin }) => pin.artifactId === input.id && pin.revision === revision),
    );
    if (!matches.length || new Set(matches.map(({ pin }) => pin.sha256)).size !== 1) unavailable();
    const expectedHash = matches[0].pin.sha256;
    await permit(input);
    current();
    const metadata = artifacts.metadataForRevision(input.id, revision);
    let sourceView: ReturnType<TelosSourceCapture['read']> | undefined;
    if (metadata.sourceKind === 'source_capture') {
      const selectedSource = matches.find(
        ({ itemId, source }) =>
          itemId === metadata.itemId &&
          source?.itemId === metadata.itemId &&
          source.artifacts.at(-1)?.artifactId === input.id &&
          source.artifacts.at(-1)?.revision === revision,
      )?.source;
      if (!selectedSource || !owners.sources) unavailable();
      sourceView = owners.sources.read(metadata.itemId, selectedSource.snapshotId, actor);
      if (!isDeepStrictEqual(sourceView.snapshot, selectedSource)) unavailable();
    }
    // Run callbacks first, then perform final synchronous owner reads and exact
    // byte checks with no authority callbacks after transferring the BLOB.
    current();
    const currentWork = work.read(metadata.itemId, actor);
    if (
      sourceView &&
      !isDeepStrictEqual(
        currentWork.sources.find((source) => source.snapshotId === sourceView!.snapshot.snapshotId),
        sourceView.snapshot,
      )
    )
      unavailable();
    if (!artifacts.userUploadAllowed(metadata.itemId)) unavailable();
    const { bytes, ...artifact } = artifacts.readBoundedRevision(
      input.id,
      revision,
      MAX_TELOS_ARTIFACT_BYTES,
    );
    if (
      !isDeepStrictEqual(artifact, metadata) ||
      artifact.sha256 !== expectedHash ||
      hash(bytes) !== expectedHash
    )
      unavailable();
    if (
      sourceView &&
      !isDeepStrictEqual(
        TelosSourcePacketSchema.parse(JSON.parse(bytes.toString('utf8'))),
        sourceView.packet,
      )
    )
      unavailable();
    const text = bytes.toString('utf8');
    const encoding = Buffer.from(text, 'utf8').equals(bytes) ? 'utf8' : 'base64';
    return result({ ...artifact, encoding, content: bytes.toString(encoding) });
  } catch {
    return {
      isError: true,
      content:
        'Telos artifact operation unavailable. Preserve the draft and retry the exact original request to recover any committed save receipt.',
    };
  }
}
