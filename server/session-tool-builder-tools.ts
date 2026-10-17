import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import { registerAuthSession, isAuthSessionCurrent } from './auth.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import {
  agentToolAllowed,
  hasAgentToolSelection,
  filterAgentTools,
} from './agent-tool-selection.js';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import { canonical, AuthoritySnapshot, identity } from './sandbox-authority.js';
import { loadAccountProfiles } from './account-profiles.js';
import { privateCodexRoots } from './codex-private-path.js';
import {
  ToolBuilderService,
  type ToolBuilderExecutor,
  type ToolBuilderWorkspace,
} from './tool-builder.js';
import type { ToolBuilderRecord, ToolBuilderStore } from './tool-builder-store.js';
import { getToolBuilderStore } from './tool-builder-runtime.js';
import { createToolBuilderWorkspace } from './tool-builder-workspace.js';
import { createToolBuilderExecutor } from './tool-builder-test-runner.js';
import { createToolBuilderCatalog, type ToolBuilderCatalogReader } from './tool-builder-catalog.js';
import {
  toolBuilderToolDefinitions,
  toolBuilderToolSchemas,
} from './tool-builder-tool-definitions.js';
import { getApiToolCatalog } from './api-tool-runtime.js';
import { getConfiguredToolCatalog } from './configured-tool-runtime.js';
import { getCredentialConnectionsRuntime } from './credential-connections-runtime.js';
import { loadMcpServers } from './mcp-config.js';

export interface ToolBuilderSessionOptions {
  store?: ToolBuilderStore;
  catalog?: ToolBuilderCatalogReader;
  executor?: ToolBuilderExecutor;
  allocateWorkspace?: (
    worktree: string,
    signal: AbortSignal,
    approvedBase?: { dev: string; ino: string },
  ) => Promise<ToolBuilderWorkspace>;
  approve?: ReturnType<typeof buildPermissionHandler>;
  privateRoots?: () => string[];
  sourceEnv?: Record<string, string>;
  assertRuntimeCurrent?: () => Promise<void>;
  assertRuntimeCurrentSync?: () => void;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const contains = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};
function summary(record: ToolBuilderRecord) {
  return {
    id: record.draft.id,
    version: record.draft.version,
    status: record.status,
    name: record.draft.name,
    contractDigest: record.draft.contractDigest,
    sourceDigest: record.draft.sourceDigest,
    tests: {
      passed: record.draft.tests.passed,
      complete: record.draft.tests.complete,
      evidenceKind: record.draft.tests.evidenceKind,
      summary: record.draft.tests.summary,
      examples: record.draft.tests.examples.length,
    },
    fileCount: record.draft.files.length,
    files: record.draft.files.slice(0, 10).map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content),
    })),
    review: record.review,
    reviewPath: `/agent-library?library=tools&toolDraft=${record.draft.id}&draftVersion=${record.draft.version}`,
  };
}

/** Only ordinary local API sessions enroll these tools. No custodian proxy or shell surface. */
export function sessionToolBuilderTools(
  sessionId: string,
  session: ManagedSession,
  registry: SessionRegistry,
  options: ToolBuilderSessionOptions = {},
) {
  const pending = new Map<string, { hash: string; promise: Promise<unknown> }>();
  const definitions = hasAgentToolSelection(session)
    ? filterAgentTools(session, toolBuilderToolDefinitions)
    : [];
  return {
    definitions,
    async execute(
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      call?: { turnId: string; callId: string; forcePrompt?: boolean },
    ) {
      if (!Object.hasOwn(toolBuilderToolSchemas, name)) return undefined;
      let unregister = () => {};
      try {
        const owner = registry.findBySessionId(sessionId);
        if (!owner) throw Error('Builder session unavailable');
        const connectionId = session.ownerConnectionId ?? owner.clientId.split(':')[0];
        const authorization = captureAgentLibraryAuthorization(connectionId);
        const controller = new AbortController();
        unregister = registerAuthSession(authorization.auth, () => controller.abort());
        signal = AbortSignal.any([signal, session.abortController.signal, controller.signal]);
        const mutating = [
          'ToolBuilderPrepareDraft',
          'ToolBuilderReviseDraft',
          'ToolBuilderSubmitReview',
        ].includes(name);
        const check = () => {
          signal.throwIfAborted();
          options.assertRuntimeCurrentSync?.();
          authorization.assertCurrent();
          const current = registry.findBySessionId(sessionId);
          if (
            !current ||
            current.session !== session ||
            (session.ownerConnectionId ?? current.clientId.split(':')[0]) !== connectionId ||
            !isAuthSessionCurrent(authorization.auth) ||
            !hasAgentToolSelection(session) ||
            !agentToolAllowed(session, name) ||
            checkSkillPolicy(registry, current.clientId, name) === 'deny' ||
            (mutating && effectivePermissionMode(session) === 'ask')
          )
            throw Error('Builder authority changed or development is unavailable in Ask mode');
        };
        check();
        await options.assertRuntimeCurrent?.();
        check();
        const parsed =
          toolBuilderToolSchemas[name as keyof typeof toolBuilderToolSchemas].parse(input);
        if (mutating && (!call?.turnId || !call.callId))
          throw Error('Verified builder tool call identity is required');
        const store = options.store ?? getToolBuilderStore();
        const service = getCredentialConnectionsRuntime();
        const catalog =
          options.catalog ??
          createToolBuilderCatalog({
            store,
            ...(service ? { api: { catalog: getApiToolCatalog(), service } } : {}),
            configured: {
              catalog: getConfiguredToolCatalog(),
              options: {
                cwd: session.cwd ?? '',
                env: { ...(options.sourceEnv ?? {}) },
                signal,
                readSources: loadMcpServers,
                assertRuntimeCurrent: check,
              },
            },
          });
        const own = (id: string, version?: number) => {
          check();
          const record = store.read('user', id, version);
          if (!record || record.sessionId !== sessionId)
            throw Error('Draft is not owned by this builder conversation');
          return record;
        };
        const approve = async (metadata: Record<string, unknown>) => {
          check();
          const approved = await (
            options.approve ?? buildPermissionHandler(owner.clientId, registry)
          )(name, structuredClone(metadata), {
            signal,
            toolUseID: call!.callId,
            forcePrompt: true,
            allowSessionGrant: false,
            rememberSessionGrant: false,
            approvalScope: 'request',
            title: 'Prepare this tool draft?',
            description:
              'Create an isolated development workspace and run the fixed offline checks. Review and publication are separate actions.',
          });
          await options.assertRuntimeCurrent?.();
          check();
          if (approved.behavior !== 'allow' || !isDeepStrictEqual(approved.updatedInput, metadata))
            throw Error('Builder development approval denied or changed');
        };
        if (
          call?.forcePrompt &&
          !['ToolBuilderPrepareDraft', 'ToolBuilderReviseDraft'].includes(name)
        )
          await approve({ operation: name, ...parsed });
        let value: unknown;
        if (name === 'ToolBuilderSearchCatalog')
          value = {
            matches: await catalog.search(
              toolBuilderToolSchemas.ToolBuilderSearchCatalog.parse(parsed).query,
            ),
          };
        else if (name === 'ToolBuilderReadContract')
          value = await catalog.readContract(
            toolBuilderToolSchemas.ToolBuilderReadContract.parse(parsed).reference,
          );
        else if (name === 'ToolBuilderInspectDraft') {
          const request = toolBuilderToolSchemas.ToolBuilderInspectDraft.parse(parsed);
          const record = own(request.id, request.version);
          if (request.path) {
            const file = record.draft.files.find((file) => file.path === request.path);
            if (!file) throw Error('Draft source path was not found');
            value = {
              id: record.draft.id,
              version: record.draft.version,
              path: file.path,
              content: file.content.slice(request.offset, request.offset + 16000),
              nextOffset:
                request.offset + 16000 < file.content.length ? request.offset + 16000 : null,
            };
          } else
            value = {
              ...summary(record),
              inputSchema: record.draft.inputSchema,
              outputSchema: record.draft.outputSchema,
              examples: record.draft.examples,
              permissions: record.draft.permissions,
              compatibility: record.draft.compatibility,
            };
        } else if (name === 'ToolBuilderSubmitReview') {
          const request = toolBuilderToolSchemas.ToolBuilderSubmitReview.parse(parsed);
          own(request.id, request.version);
          value = summary(
            store.submit('user', sessionId, request.id, request.version, request.contractDigest),
          );
        } else {
          const request =
            name === 'ToolBuilderReviseDraft'
              ? toolBuilderToolSchemas.ToolBuilderReviseDraft.parse(parsed)
              : toolBuilderToolSchemas.ToolBuilderPrepareDraft.parse(parsed);
          const inputHash = hash(parsed);
          const requestKey = hash([sessionId, call!.turnId, call!.callId]);
          const retry = store.request('user', sessionId, requestKey);
          if (retry) {
            if (retry.requestHash !== inputHash) throw Error('Conflicting builder retry identity');
            value = { kind: 'draft', draft: summary(retry.record) };
          } else {
            const active = pending.get(requestKey);
            if (active) {
              if (active.hash !== inputHash) throw Error('Conflicting in-flight builder request');
              value = await active.promise;
            } else {
              const work = async () => {
                const prior =
                  'expectedVersion' in request
                    ? own(request.id, request.expectedVersion)
                    : undefined;
                const expectedVersion =
                  'expectedVersion' in request ? request.expectedVersion : undefined;
                const feedback = 'feedback' in request ? request.feedback : undefined;
                if (
                  prior &&
                  (store.read('user', prior.draft.id)?.draft.version !== expectedVersion ||
                    ['submitted', 'cancelled'].includes(prior.status))
                )
                  throw Error('Draft version conflict or pending review');
                if (prior?.status === 'rejected' && prior.review?.feedback !== feedback)
                  throw Error('Use the exact stored independent review feedback');
                const matches = await catalog.search(request.request);
                check();
                if ('reuse' in request && request.reuse) {
                  const contract = await catalog.readContract(request.reuse);
                  check();
                  return {
                    kind: request.reuse.id.startsWith('template:') ? 'configure_template' : 'reuse',
                    reference: request.reuse,
                    contractDigest: hash(contract),
                    readWith: 'ToolBuilderReadContract',
                  };
                }
                const equivalent = matches.find(
                  (match) => match.equivalent && match.id !== `custom:${prior?.draft.id}`,
                );
                if (equivalent)
                  return {
                    kind: 'reuse',
                    tool: {
                      id: equivalent.id,
                      version: equivalent.version,
                      name: equivalent.name.slice(0, 80),
                      description: equivalent.description.slice(0, 500),
                      ...('reference' in equivalent ? { reference: equivalent.reference } : {}),
                    },
                  };
                if (!request.custom)
                  return {
                    kind: 'needs_specification',
                    matchCount: matches.length,
                    readWith: 'ToolBuilderSearchCatalog',
                  };
                const primary = session.worktreePaths.get('primary')?.path;
                if (!primary) throw Error('An authorized isolated session worktree is required');
                const privateRoots =
                  options.privateRoots ??
                  (() => privateCodexRoots(loadAccountProfiles().privateCodexRoots()));
                const scope = (path: string) => {
                  const target = canonical(path);
                  if (
                    privateRoots()
                      .map(canonical)
                      .some((root) => contains(root, target) || contains(target, root))
                  )
                    throw Error('Development workspace overlaps private runtime authority');
                };
                const primaryRoot = realpathSync(primary);
                const authority = new AuthoritySnapshot();
                authority.capture(primaryRoot);
                const primaryIdentity = identity(primaryRoot)!;
                if (!primaryIdentity.isDirectory())
                  throw Error('Development worktree is unavailable');
                const approvedBase = {
                  dev: String(primaryIdentity.dev),
                  ino: String(primaryIdentity.ino),
                };
                scope(primaryRoot);
                check();
                await approve({
                  request: request.request,
                  tool: request.custom.name,
                  contractDigest: hash(request.custom),
                  fileCount: request.custom.files.length,
                  files: request.custom.files.slice(0, 10).map((file) => file.path),
                  testProfile: 'unit',
                  ...(prior
                    ? { draftId: prior.draft.id, expectedVersion: prior.draft.version, feedback }
                    : {}),
                });
                let completedWorkspace: ToolBuilderWorkspace | undefined;
                const builder = new ToolBuilderService({
                  catalog: {
                    search: async () =>
                      matches.map((match) => ({
                        ...match,
                        equivalent: match.equivalent && match.id !== `custom:${prior?.draft.id}`,
                      })),
                  },
                  allocateWorkspace: async () => {
                    check();
                    authority.verify();
                    if (session.worktreePaths.get('primary')?.path !== primary)
                      throw Error('Development workspace authority changed');
                    scope(primaryRoot);
                    const workspace = await (
                      options.allocateWorkspace ?? createToolBuilderWorkspace
                    )(primaryRoot, signal, approvedBase);
                    completedWorkspace = workspace;
                    const currentScope = () => {
                      check();
                      authority.verify();
                      if (session.worktreePaths.get('primary')?.path !== primary)
                        throw Error('Development workspace authority changed');
                      scope(workspace.root);
                    };
                    return {
                      ...workspace,
                      async write(path, content) {
                        currentScope();
                        await workspace.write(path, content);
                        currentScope();
                      },
                      async snapshot() {
                        currentScope();
                        const files = await workspace.snapshot();
                        currentScope();
                        return files;
                      },
                      async read(path) {
                        currentScope();
                        const content = await workspace.read(path);
                        currentScope();
                        return content;
                      },
                      async discard() {
                        scope(workspace.root);
                        await workspace.discard();
                      },
                    };
                  },
                  executor:
                    options.executor ??
                    createToolBuilderExecutor({
                      privateRoots,
                      assertCurrent: check,
                      assertRuntimeCurrent: options.assertRuntimeCurrent,
                    }),
                });
                const result = await builder.propose({
                  request: request.request,
                  custom: request.custom,
                  signal,
                });
                if (result.kind !== 'draft') return result;
                try {
                  check();
                  const draft = {
                    ...result.draft,
                    ...(prior ? { id: prior.draft.id, version: prior.draft.version + 1 } : {}),
                  };
                  const saved = store.save(
                    'user',
                    sessionId,
                    requestKey,
                    draft,
                    prior?.draft.version ?? 0,
                    inputHash,
                  );
                  return { kind: 'draft', draft: summary(saved) };
                } catch (error) {
                  // Core retains successful work for review. If persistence fails,
                  // this conversation has no retained draft to own that workspace.
                  try {
                    await completedWorkspace?.discard();
                  } catch (cleanup) {
                    throw new AggregateError(
                      [error, cleanup],
                      'Draft persistence and cleanup failed',
                      { cause: cleanup },
                    );
                  }
                  throw error;
                }
              };
              const promise = work();
              pending.set(requestKey, { hash: inputHash, promise });
              try {
                value = await promise;
              } finally {
                if (pending.get(requestKey)?.promise === promise) pending.delete(requestKey);
              }
            }
          }
        }
        check();
        await options.assertRuntimeCurrent?.();
        check();
        const serialized = JSON.stringify(value);
        const resultOffset = 'resultOffset' in parsed ? parsed.resultOffset : 0;
        const resultDigest = createHash('sha256').update(serialized).digest('hex');
        if (
          resultOffset > 0 &&
          (!('resultDigest' in parsed) || parsed.resultDigest !== resultDigest)
        )
          throw Error(
            'Paged result changed or its continuation digest is missing; restart this read',
          );
        return {
          content:
            resultOffset > 0 || Buffer.byteLength(serialized) > 32000
              ? JSON.stringify({
                  partial: true,
                  encoding: 'json',
                  resultDigest,
                  json: serialized.slice(resultOffset, resultOffset + 4000),
                  nextResultOffset:
                    resultOffset + 4000 < serialized.length ? resultOffset + 4000 : null,
                })
              : serialized,
          isError: false,
        };
      } catch (error) {
        return {
          content:
            error instanceof Error ? error.message.slice(0, 4000) : 'Tool Builder request failed',
          isError: true,
        };
      } finally {
        unregister();
      }
    },
  };
}
