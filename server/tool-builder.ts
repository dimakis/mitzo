import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import { validateToolBuilderExamples } from './tool-builder-schema.js';

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

const JsonSchema = z.record(z.string(), z.json());
const File = z.strictObject({
  path: RelativeFile,
  content: z
    .string()
    .max(256_000)
    .refine(
      (value) => Buffer.byteLength(value) <= 256_000,
      'Draft source file exceeds its UTF-8 byte limit',
    ),
});
const Files = z
  .array(File)
  .min(1)
  .max(100)
  .superRefine((files, ctx) => {
    if (new Set(files.map((file) => file.path)).size !== files.length)
      ctx.addIssue({ code: 'custom', message: 'Draft file paths must be unique' });
    if (files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 2_000_000)
      ctx.addIssue({ code: 'custom', message: 'Draft source exceeds the workspace limit' });
  });
const Example = z.strictObject({ input: JsonSchema, expected: JsonSchema });
export const CustomToolDraftInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
    examples: z.array(Example).min(1).max(20),
    permissions: z.strictObject({
      behavior: z.enum(['read', 'write', 'mixed']),
      requiredConnections: z.array(z.string().trim().min(1).max(128)).max(20),
    }),
    compatibility: z.strictObject({ routes: z.array(z.string().trim().min(1).max(64)).max(20) }),
    files: Files,
    testProfile: z.enum(['unit', 'contract']),
  })
  .superRefine((input, ctx) => {
    if (Buffer.byteLength(canonicalJson(input)) > 3_000_000)
      ctx.addIssue({ code: 'custom', message: 'Draft contract exceeds the review limit' });
  });

export type ToolBuilderWorkspace = {
  id: string;
  root: string;
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
  /** Enumerate the complete source set, rejecting links and nonregular files. */
  snapshot(): Promise<Array<z.infer<typeof File>>>;
  discard(): Promise<void>;
};
export type ToolBuilderCatalog = {
  search(
    query: string,
  ): Promise<
    Array<{ id: string; version: number; name: string; description: string; equivalent?: boolean }>
  >;
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
    evidenceKind: 'candidate-report' | 'trusted-executor';
    summary: string;
    output?: string;
    examples: Array<{ actual: Record<string, unknown>; passed: boolean }>;
  }>;
};
type CustomInput = z.infer<typeof CustomToolDraftInputSchema>;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const sortedFiles = (files: CustomInput['files']) =>
  [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
export function toolBuilderSourceDigest(files: CustomInput['files']) {
  return digest(sortedFiles(Files.parse(files)));
}
/** Includes schemas, examples, permissions, compatibility and the chosen test profile. */
export function toolBuilderContractDigest(input: CustomInput) {
  const contract = CustomToolDraftInputSchema.strip().parse(input);
  return digest({ ...contract, files: sortedFiles(contract.files) });
}
const TestResult = z.strictObject({
  passed: z.boolean(),
  complete: z.boolean(),
  evidenceKind: z.enum(['candidate-report', 'trusted-executor']),
  summary: z.string().trim().min(1).max(500),
  output: z.string().max(32_000).optional(),
  examples: z.array(z.strictObject({ actual: JsonSchema, passed: z.boolean() })).max(20),
});
export type ToolBuilderDraft = CustomInput & {
  id: string;
  version: number;
  status: 'unpublished';
  workspaceId: string;
  sourceDigest: string;
  contractDigest: string;
  tests: {
    passed: true;
    complete: true;
    evidenceKind: 'candidate-report' | 'trusted-executor';
    summary: string;
    sourceDigest: string;
    contractDigest: string;
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

    const custom = CustomToolDraftInputSchema.parse(input.custom);
    const schemas = validateToolBuilderExamples(custom);
    const workspace = await this.options.allocateWorkspace();
    try {
      signal.throwIfAborted();
      for (const file of custom.files) {
        signal.throwIfAborted();
        await workspace.write(file.path, file.content);
      }
      const sourceDigest = toolBuilderSourceDigest(custom.files);
      const contractDigest = toolBuilderContractDigest(custom);
      if (toolBuilderSourceDigest(await workspace.snapshot()) !== sourceDigest)
        throw new Error('Tool draft workspace does not match the requested source');
      signal.throwIfAborted();
      const test = TestResult.parse(
        await this.options.executor.run({
          workspace,
          profile: custom.testProfile,
          signal,
          examples: structuredClone(custom.examples),
        }),
      );
      signal.throwIfAborted();
      for (const example of test.examples) schemas.output.validate(example.actual);
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
      if (toolBuilderSourceDigest(await workspace.snapshot()) !== sourceDigest)
        throw new Error('Tool draft source changed during testing');
      const draft: ToolBuilderDraft = {
        ...custom,
        id: randomUUID(),
        version: 1,
        status: 'unpublished',
        workspaceId: workspace.id,
        sourceDigest,
        contractDigest,
        tests: {
          passed: true,
          complete: true,
          evidenceKind: test.evidenceKind,
          summary: test.summary,
          sourceDigest,
          contractDigest,
          examples: custom.examples.map((example, index) => ({
            ...example,
            actual: test.examples[index].actual,
          })),
        },
      };
      signal.throwIfAborted();
      this.drafts.set(draft.id, structuredClone(draft));
      return { kind: 'draft' as const, draft: structuredClone(draft) };
    } catch (error) {
      try {
        await workspace.discard();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Tool draft failed and workspace cleanup failed',
          { cause: cleanup },
        );
      }
      throw error;
    }
  }

  getDraft(id: string) {
    const draft = this.drafts.get(id);
    return draft ? structuredClone(draft) : null;
  }
}
