import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { z } from 'zod';
import { CustomToolRegistry, type InstalledCustomTool } from '../../custom-tool-registry.js';
import { ToolBuilderStore } from '../../tool-builder-store.js';
import {
  CustomToolDraftInputSchema,
  toolBuilderSourceDigest,
  toolBuilderContractDigest,
  type ToolBuilderDraft,
} from '../../tool-builder.js';

export const toolBuilderFixtureId = 'c2f63831-e4bc-46c2-ab36-7b7850ad501a';
const input = z.object({ text: z.string() }).strict();
const output = z.object({ length: z.number().int() }).strict();
export function toolBuilderFixture(path = ':memory:') {
  const id = toolBuilderFixtureId;
  const contract = CustomToolDraftInputSchema.parse({
    name: 'Text length',
    description: 'Count text characters',
    inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(input))),
    outputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(output))),
    examples: [{ input: { text: 'abc' }, expected: { length: 3 } }],
    permissions: { behavior: 'read', requiredConnections: [] },
    compatibility: { routes: ['local-api'] },
    testProfile: 'unit',
    files: [
      {
        path: 'src/index.mts',
        content: 'export const runTool = ({text}: {text:string}) => ({length: text.length});\n',
      },
      {
        path: 'test/index.test.mts',
        content:
          'import {test} from "node:test";import {qualify} from "./qualify.mts";test("length",qualify);\n',
      },
      {
        path: 'test/qualify.mts',
        content:
          'import assert from "node:assert/strict";import {runTool} from "../src/index.mts";export async function qualify(){assert.deepEqual(runTool({text:"abc"}),{length:3});}\n',
      },
    ],
  });
  const sourceDigest = toolBuilderSourceDigest(contract.files);
  const contractDigest = toolBuilderContractDigest(contract);
  const draft = {
    ...contract,
    id,
    version: 1,
    status: 'unpublished' as const,
    workspaceId: 'workspace',
    sourceDigest,
    contractDigest,
    tests: {
      passed: true as const,
      complete: true as const,
      summary: 'Unit tests and examples passed',
      evidenceKind: 'trusted-executor' as const,
      sourceDigest,
      contractDigest,
      examples: [{ ...contract.examples[0], actual: { length: 3 } }],
    },
  };
  const qualify = vi.fn(async (_signal: AbortSignal) => {});
  const execute = vi.fn(async (value: Record<string, unknown>) => ({
    length: String(value.text).length,
  }));
  const sourceFiles = Object.fromEntries(
    contract.files.map((file) => [file.path, `../custom-tools/${id}/${file.path}`]),
  );
  const entry: InstalledCustomTool = {
    id: `custom:${id}`,
    version: 1,
    contractDigest,
    sourceFiles,
    executorSource: sourceFiles['src/index.mts'],
    qualifierSource: sourceFiles['test/qualify.mts'],
    qualify,
    input,
    output,
    execute,
  };
  let state = {
    entries: [entry],
    artifacts: Object.fromEntries(
      contract.files.map((file) => [
        sourceFiles[file.path],
        createHash('sha256').update(file.content).digest('hex'),
      ]),
    ),
    revision: 'fixture-v1',
  };
  const registry = new CustomToolRegistry(() => state);
  const store = new ToolBuilderStore(path, registry);
  return {
    draft,
    entry,
    registry,
    store,
    execute,
    qualify,
    installDraft(draft: ToolBuilderDraft) {
      const sourceFiles = Object.fromEntries(
        draft.files.map((file) => [
          file.path,
          `../custom-tools/${draft.id}/v${draft.version}/${file.path}`,
        ]),
      );
      const installed = {
        ...entry,
        id: `custom:${draft.id}`,
        version: draft.version,
        contractDigest: draft.contractDigest,
        sourceFiles,
        executorSource: sourceFiles['src/index.mts'],
        qualifierSource: sourceFiles['test/qualify.mts'],
      };
      state = {
        entries: [...state.entries, installed],
        artifacts: {
          ...state.artifacts,
          ...Object.fromEntries(
            draft.files.map((file) => [
              sourceFiles[file.path],
              createHash('sha256').update(file.content).digest('hex'),
            ]),
          ),
        },
        revision: state.revision + '-installed',
      };
    },
    drift: () => {
      state = { ...state, revision: 'fixture-v2' };
    },
  };
}
