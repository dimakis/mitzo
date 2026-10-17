import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import { z } from 'zod';

const RelativeFile = z
  .string()
  .min(1)
  .max(240)
  .refine((path) => {
    const normalized = normalize(path);
    return (
      !isAbsolute(path) &&
      normalized !== '..' &&
      !normalized.startsWith(`..${sep}`) &&
      !path.includes('\\') &&
      relative('.', normalized) !== '..'
    );
  }, 'File path must stay inside the authorized workspace');

const JsonSchema = z.record(z.string(), z.unknown());
const Example = z.strictObject({ input: JsonSchema, expected: JsonSchema });
export const CustomToolDraftInputSchema = z.strictObject({
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
});

export type ToolBuilderWorkspace = {
  id: string;
  root: string;
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
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
  }): Promise<{
    passed: boolean;
    summary: string;
    output?: string;
    complete?: boolean;
  }>;
};
type CustomInput = z.infer<typeof CustomToolDraftInputSchema>;
export type ToolBuilderDraft = CustomInput & {
  id: string;
  version: number;
  status: 'unpublished';
  workspaceId: string;
  sourceDigest: string;
  tests: { passed: true; summary: string; sourceDigest: string };
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
    if (new Set(custom.files.map((file) => file.path)).size !== custom.files.length)
      throw new Error('Draft file paths must be unique');
    const workspace = await this.options.allocateWorkspace();
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
    });
    signal.throwIfAborted();
    if (!test.passed || test.complete === false)
      throw new Error('Tool draft tests did not complete successfully');
    if (
      (await this.digest(
        custom.files.map(({ path }) => path),
        workspace,
      )) !== sourceDigest
    )
      throw new Error('Tool draft source changed during testing');
    const draft: ToolBuilderDraft = {
      ...custom,
      id: randomUUID(),
      version: 1,
      status: 'unpublished',
      workspaceId: workspace.id,
      sourceDigest,
      tests: { passed: true, summary: test.summary.slice(0, 500), sourceDigest },
    };
    this.drafts.set(draft.id, draft);
    return { kind: 'draft' as const, draft };
  }

  getDraft(id: string) {
    return this.drafts.get(id) ?? null;
  }

  private async digest(paths: string[], workspace: ToolBuilderWorkspace) {
    const hash = createHash('sha256');
    for (const path of [...paths].sort())
      hash.update(JSON.stringify([path, await workspace.read(path)]));
    return hash.digest('hex');
  }
}
