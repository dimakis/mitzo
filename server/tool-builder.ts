import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ToolBuilderStore } from './tool-builder-store.js';

const RelativeFile = z
  .string()
  .min(1)
  .max(240)
  .refine((path) => {
    return (
      !isAbsolute(path) &&
      !path.split('/').some((part) => part === '..' || part === '.' || part.length === 0) &&
      !path.includes('\\') &&
      !path.includes('\0')
    );
  }, 'File path must stay inside the authorized workspace');

const JsonSchema = z.record(z.string(), z.unknown());
const IdLike = z.string().trim().min(1).max(128);
const Example = z.strictObject({ input: JsonSchema, expected: JsonSchema });
export const CustomToolDraftInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    inputSchema: JsonSchema,
    examples: z.array(Example).min(1).max(20),
    permissions: z.strictObject({
      behavior: z.enum(['read', 'write', 'mixed']),
      requiredConnections: z.array(z.string().trim().min(1).max(128)).max(20),
    }),
    compatibility: z.strictObject({ routes: z.array(z.string().trim().min(1).max(64)).max(20) }),
    files: z
      .array(z.strictObject({ path: RelativeFile, content: z.string().max(256_000) }))
      .min(1)
      .max(100),
    testProfile: z.enum(['unit', 'contract']),
  })
  .superRefine((input, ctx) => {
    if (!input.files.some((file) => file.path === 'src/index.mjs'))
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Drafts require src/index.mjs exporting runTool(input)',
      });
    if (!input.files.some((file) => /^test\/.+\.test\.mjs$/.test(file.path)))
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Drafts require at least one test/*.test.mjs file',
      });
  });

export type ToolBuilderWorkspace = {
  id: string;
  root: string;
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
  discard?(): Promise<void>;
};
export type ToolBuilderCatalog = {
  search(
    query: string,
  ): Promise<
    Array<{ id: string; version: number; name: string; description: string; equivalent?: boolean }>
  >;
  readContract?(id: string, version: number): Promise<unknown> | unknown;
};
export type ToolBuilderExecutor = {
  run(input: {
    workspace: ToolBuilderWorkspace;
    profile: 'unit' | 'contract';
    signal: AbortSignal;
    examples: CustomInput['examples'];
  }): Promise<{
    passed: boolean;
    complete: boolean;
    summary: string;
    output?: string;
    examples: Array<{ actual: Record<string, unknown>; passed: boolean }>;
  }>;
};
type CustomInput = z.infer<typeof CustomToolDraftInputSchema>;
export function toolBuilderSourceDigest(files: readonly { path: string; content: string }[]) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(JSON.stringify([file.path, file.content]));
  return hash.digest('hex');
}
export type ToolBuilderDraft = CustomInput & {
  id: string;
  toolId: string;
  version: number;
  status: 'unpublished';
  workspaceId: string;
  sourceDigest: string;
  tests: {
    passed: true;
    complete: true;
    summary: string;
    sourceDigest: string;
    examples: Array<{
      input: Record<string, unknown>;
      expected: Record<string, unknown>;
      actual: Record<string, unknown>;
    }>;
  };
};

export class ToolBuilderService {
  private readonly drafts = new Map<string, ToolBuilderDraft>();
  constructor(
    private readonly options: {
      catalog: ToolBuilderCatalog;
      allocateWorkspace: () => Promise<ToolBuilderWorkspace>;
      executor: ToolBuilderExecutor;
      store?: ToolBuilderStore;
      authorId?: string;
    },
  ) {}

  async propose(input: { request: string; custom?: unknown; signal?: AbortSignal }) {
    const request = z.string().trim().min(1).max(2_000).parse(input.request);
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const matches = await this.options.catalog.search(request);
    signal.throwIfAborted();
    const equivalent = matches.find((match) => match.equivalent);
    if (equivalent) return { kind: 'reuse' as const, tool: equivalent };
    if (!input.custom) return { kind: 'needs_specification' as const, matches };
    return this.prepare(CustomToolDraftInputSchema.parse(input.custom), signal);
  }

  searchCatalog(query: string) {
    return this.options.catalog.search(z.string().trim().min(1).max(2_000).parse(query));
  }

  readContract(id: string, version: number) {
    if (!this.options.catalog.readContract) throw Error('Tool contract reader is unavailable');
    return this.options.catalog.readContract(
      IdLike.parse(id),
      z.number().int().positive().parse(version),
    );
  }

  inspectDraft(id: string, version?: number) {
    return this.options.store?.getDraft(id, version) ?? this.drafts.get(id) ?? null;
  }

  async reviseDraft(input: {
    id: string;
    expectedVersion: number;
    feedback: string;
    custom: unknown;
    signal?: AbortSignal;
  }) {
    const prior = this.options.store?.getDraft(input.id, input.expectedVersion);
    if (!prior || prior.status !== 'rejected' || !prior.review?.feedback)
      throw Error('Only a draft with independent review feedback can be revised');
    if (prior.review.feedback !== input.feedback)
      throw Error('Review feedback does not match the selected draft version');
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    return this.prepare(CustomToolDraftInputSchema.parse(input.custom), signal, {
      id: prior.id,
      toolId: prior.content.toolId,
      expectedVersion: prior.version,
    });
  }

  private async prepare(
    custom: CustomInput,
    signal: AbortSignal,
    revision?: { id: string; toolId: string; expectedVersion: number },
  ) {
    if (new Set(custom.files.map((file) => file.path)).size !== custom.files.length)
      throw new Error('Draft file paths must be unique');
    const workspace = await this.options.allocateWorkspace();
    try {
      signal.throwIfAborted();
      for (const file of custom.files) {
        signal.throwIfAborted();
        await workspace.write(file.path, file.content);
      }
      const sourceDigest = await this.digest(
        custom.files.map(({ path }) => path),
        workspace,
      );
      const test = await this.options.executor.run({
        workspace,
        profile: custom.testProfile,
        signal,
        examples: custom.examples,
      });
      signal.throwIfAborted();
      if (
        !test.passed ||
        !test.complete ||
        test.examples.length !== custom.examples.length ||
        test.examples.some(
          (result, index) =>
            !result.passed || !isDeepStrictEqual(result.actual, custom.examples[index].expected),
        )
      )
        throw new Error('Tool draft tests did not complete successfully');
      if (
        (await this.digest(
          custom.files.map(({ path }) => path),
          workspace,
        )) !== sourceDigest
      )
        throw new Error('Tool draft source changed during testing');
      const id = revision?.id ?? randomUUID();
      const slug =
        custom.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || 'tool';
      const toolId = revision?.toolId ?? `custom:${slug}-${randomUUID().slice(0, 8)}`;
      const draft: ToolBuilderDraft = {
        ...custom,
        id,
        toolId,
        version: (revision?.expectedVersion ?? 0) + 1,
        status: 'unpublished',
        workspaceId: workspace.id,
        sourceDigest,
        tests: {
          passed: true,
          complete: true,
          summary: test.summary.slice(0, 500),
          sourceDigest,
          examples: custom.examples.map((example, index) => ({
            ...example,
            actual: test.examples[index].actual,
          })),
        },
      };
      const content = {
        ...custom,
        toolId,
        sourceDigest,
        testEvidence: draft.tests,
      };
      if (revision)
        this.options.store!.reviseDraft({ id, expectedVersion: revision.expectedVersion, content });
      else
        this.options.store?.createDraft({
          id,
          authorId: this.options.authorId ?? id,
          content,
        });
      this.drafts.set(draft.id, draft);
      return { kind: 'draft' as const, draft };
    } catch (error) {
      await workspace.discard?.().catch(() => undefined);
      throw error;
    }
  }

  submitForReview(id: string, version: number, sourceDigest: string) {
    if (!this.options.store) throw new Error('Tool review service is unavailable');
    return this.options.store.submitForReview(id, version, sourceDigest);
  }

  getDraft(id: string) {
    return this.drafts.get(id) ?? null;
  }

  private async digest(paths: string[], workspace: ToolBuilderWorkspace) {
    const files = await Promise.all(
      paths.map(async (path) => ({ path, content: await workspace.read(path) })),
    );
    return toolBuilderSourceDigest(files);
  }
}
