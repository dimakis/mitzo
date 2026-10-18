import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { CustomToolReferenceSchema } from '@mitzo/protocol';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import { reviewedHandlerSourceFingerprint } from './connections/reviewed-handler-artifacts.js';
import {
  toolBuilderContractDigest,
  toolBuilderSourceDigest,
  type ToolBuilderDraft,
} from './tool-builder.js';
import { compileToolBuilderSchema, validateToolBuilderExamples } from './tool-builder-schema.js';

/** Code-owned registration, added only by a reviewed source change. Never HTTP/draft input. */
export interface InstalledCustomTool {
  id: string;
  version: number;
  contractDigest: string;
  sourceFiles: Readonly<Record<string, string>>;
  executorSource: string;
  qualifierSource: string;
  /** Trusted checks installed from accepted source, never a candidate report. */
  qualify(signal: AbortSignal): Promise<void>;
  input: z.ZodType<Record<string, unknown>>;
  output: z.ZodType<Record<string, unknown>>;
  execute(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface CustomToolRegistryState {
  entries: readonly InstalledCustomTool[];
  artifacts: Readonly<Record<string, string>>;
  revision: string;
}
export interface CustomToolBinding {
  id: string;
  version: number;
  sourceDigest: string;
  contractDigest: string;
  registryDigest: string;
  definition: { name: string; description: string; input_schema: Record<string, unknown> };
}
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function withSignal<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { ok: true; value: T } | { ok: false; error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (!result.ok) reject(result.error);
      else resolve(result.value);
    };
    const abort = () =>
      finish({ ok: false, error: signal.reason ?? Error('Custom qualification cancelled') });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      Promise.resolve(start()).then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, error }),
      );
    } catch (error) {
      finish({ ok: false, error });
    }
  });
}

/** No loader, command, network client or credential context exists in this registry. */
export class CustomToolRegistry {
  constructor(private readonly current: () => CustomToolRegistryState) {}

  bind(draft: ToolBuilderDraft): CustomToolBinding {
    return this.bindState(draft, this.current());
  }
  private bindState(draft: ToolBuilderDraft, state: CustomToolRegistryState): CustomToolBinding {
    const id = `custom:${draft.id}`;
    const matches = state.entries.filter(
      (entry) => entry.id === id && entry.version === draft.version,
    );
    if (matches.length !== 1) throw Error('Exact custom implementation is not installed');
    const entry = matches[0];
    CustomToolReferenceSchema.shape.id.parse(id);
    if (
      !state.revision ||
      !Object.keys(state.artifacts).length ||
      entry.contractDigest !== toolBuilderContractDigest(draft) ||
      draft.sourceDigest !== toolBuilderSourceDigest(draft.files) ||
      draft.permissions.behavior !== 'read' ||
      draft.permissions.requiredConnections.length ||
      !draft.compatibility.routes.length ||
      draft.compatibility.routes.some((route) => route !== 'local-api')
    )
      throw Error('Custom implementation contract or runtime support is unavailable');
    if (
      canonicalJson(compileToolBuilderSchema(z.toJSONSchema(entry.input)).schema) !==
        canonicalJson(compileToolBuilderSchema(draft.inputSchema).schema) ||
      canonicalJson(compileToolBuilderSchema(z.toJSONSchema(entry.output)).schema) !==
        canonicalJson(compileToolBuilderSchema(draft.outputSchema).schema) ||
      Object.keys(entry.sourceFiles).length !== draft.files.length ||
      !Object.values(entry.sourceFiles).includes(entry.executorSource) ||
      !Object.values(entry.sourceFiles).includes(entry.qualifierSource) ||
      typeof entry.qualify !== 'function' ||
      new Set(Object.values(entry.sourceFiles)).size !== draft.files.length ||
      draft.files.some(
        (file) =>
          state.artifacts[entry.sourceFiles[file.path]] !==
          reviewedHandlerSourceFingerprint(file.content),
      )
    )
      throw Error('Custom implementation sources or schemas differ from the reviewed draft');
    return {
      id,
      version: draft.version,
      sourceDigest: draft.sourceDigest,
      contractDigest: entry.contractDigest,
      registryDigest: hash({
        revision: state.revision,
        artifacts: state.artifacts,
        id,
        version: entry.version,
        contractDigest: entry.contractDigest,
        sourceFiles: entry.sourceFiles,
        executorSource: entry.executorSource,
        qualifierSource: entry.qualifierSource,
      }),
      definition: {
        name: `CustomTool_${draft.id.replaceAll('-', '')}_v${draft.version}`,
        description: draft.description,
        input_schema: structuredClone(draft.inputSchema),
      },
    };
  }

  implementation(draft: ToolBuilderDraft, binding: CustomToolBinding) {
    const state = this.current();
    if (canonicalJson(this.bindState(draft, state)) !== canonicalJson(binding))
      throw Error('Installed custom implementation changed; review and publish a new version');
    return state.entries.find(
      (entry) => entry.id === binding.id && entry.version === binding.version,
    )!;
  }

  async qualify(
    draft: ToolBuilderDraft,
    binding: CustomToolBinding,
    options: { signal: AbortSignal; assertCurrent(): void },
  ) {
    const check = () => {
      options.signal.throwIfAborted();
      options.assertCurrent();
      this.implementation(draft, binding);
    };
    check();
    const installed = this.implementation(draft, binding);
    const schema = validateToolBuilderExamples(draft);
    // The oracle and completion control live in this trusted process. Only
    // statically installed accepted code is invoked here; no draft is imported.
    await withSignal(() => installed.qualify(options.signal), options.signal);
    check();
    for (const example of draft.examples) {
      const input = installed.input.parse(structuredClone(example.input));
      check();
      const actual = await withSignal(
        () => installed.execute(input, options.signal),
        options.signal,
      );
      check();
      schema.output.validate(actual);
      installed.output.parse(actual);
      if (!isDeepStrictEqual(actual, example.expected))
        throw Error('Installed implementation failed independent example qualification');
    }
    check();
    return {
      kind: 'installed-source' as const,
      registryDigest: binding.registryDigest,
      sourceDigest: binding.sourceDigest,
      contractDigest: binding.contractDigest,
      examples: draft.examples.length,
    };
  }
}
