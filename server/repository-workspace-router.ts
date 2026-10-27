import {
  OrdinaryRepositoryRuntimeSelectionSchema,
  type OrdinaryRepositoryRuntimeSelection,
} from './ordinary-repository-preparation.js';
import express from 'express';
import { z } from 'zod';
import type { AccountBinding } from '@mitzo/protocol';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import { isDeepStrictEqual } from 'node:util';
import type {
  RepositoryWorkspace,
  RepositoryRetirementAuthorization,
} from './repository-workspaces.js';
import { requireSameOriginJson } from './connections-router.js';
import {
  RepositorySourceLimitError,
  RepositorySpaceError,
  REPOSITORY_SOURCE_LIMIT_MIB,
} from './github-repository-source.js';

const selection = z.strictObject({
  accountId: z.string().min(1).max(128),
  model: z.string().min(1).max(128),
});
const previewInput = selection.extend({
  connectionId: z.string().min(1).max(128),
  repository: z.string().min(3).max(256),
  ordinaryRuntime: OrdinaryRepositoryRuntimeSelectionSchema.optional(),
  requestId: z.uuid().optional(),
});
export function createRepositoryWorkspaceRouter(deps: {
  resolveBinding(accountId: string, model: string): AccountBinding;
  catalog(binding: AccountBinding, runOn?: 'local' | 'openshell'): unknown;
  selectLocal?(
    binding: AccountBinding,
    repositoryId: string,
    runtime: OrdinaryRepositoryRuntimeSelection,
    signal: AbortSignal,
    requestId: string,
  ): Promise<unknown>;
  chatPreparation?(id: string): unknown;
  preview(
    binding: AccountBinding,
    connectionId: string,
    repository: string,
    signal: AbortSignal,
    ordinaryRuntime?: OrdinaryRepositoryRuntimeSelection,
    requestId?: string,
  ): Promise<unknown>;
  prepare(id: string, binding: AccountBinding, signal: AbortSignal): Promise<unknown>;
  status?(id: string, binding: AccountBinding): unknown;
  discard?(
    id: string,
    binding: AccountBinding,
    authority: RepositoryRetirementAuthorization,
  ): Promise<void>;
  assertUnusedNativePreparation?(record: Readonly<RepositoryWorkspace>): void;
  assertTaskStopped?(record: Readonly<RepositoryWorkspace>): void;
  retireTask?(
    id: string,
    binding: AccountBinding,
    authority: RepositoryRetirementAuthorization,
  ): Promise<unknown>;
  restoreTask?(
    id: string,
    binding: AccountBinding,
    authority: RepositoryRetirementAuthorization,
  ): Promise<unknown>;
}) {
  const router = express.Router();
  router.use((req, res, next) => {
    const auth = res.locals.authSession as AuthSession | undefined;
    res.set('Cache-Control', 'no-store');
    if (!auth || auth.expiresAt <= Date.now())
      return res.status(401).json({ error: 'Interactive operator authentication required' });
    next();
  });
  router.get('/catalog', (req, res) => {
    const parsed = selection
      .extend({ runOn: z.enum(['local', 'openshell']).optional() })
      .safeParse(req.query);
    if (!parsed.success)
      return res.status(400).json({ error: 'Select an AI account and model first' });
    try {
      const binding = deps.resolveBinding(parsed.data.accountId, parsed.data.model);
      return res.json(
        parsed.data.runOn ? deps.catalog(binding, parsed.data.runOn) : deps.catalog(binding),
      );
    } catch {
      return res.status(409).json({ error: 'Repository account selection unavailable' });
    }
  });
  router.post('/local', requireSameOriginJson, async (req, res) => {
    const parsed = selection
      .extend({
        repositoryId: z.string().min(1).max(128),
        ordinaryRuntime: OrdinaryRepositoryRuntimeSelectionSchema.refine(
          (value) => value.runOn === 'local',
        ),
        requestId: z.uuid(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Choose a repository already on the Mac' });
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', close);
    const auth = res.locals.authSession as AuthSession;
    const timer = setTimeout(abort, Math.min(120000, Math.max(0, auth.expiresAt - Date.now())));
    try {
      if (!deps.selectLocal) throw Error('Unavailable');
      const value = parsed.data;
      const result = await deps.selectLocal(
        deps.resolveBinding(value.accountId, value.model),
        value.repositoryId,
        value.ordinaryRuntime,
        controller.signal,
        value.requestId,
      );
      controller.signal.throwIfAborted();
      return res.json(result);
    } catch {
      return res.status(409).json({
        error:
          'Could not use this local repository. Check access to its upstream main branch and try again.',
      });
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
      res.off('close', close);
    }
  });
  router.post('/preview', requireSameOriginJson, async (req, res) => {
    const input = previewInput.safeParse(req.body);
    if (!input.success)
      return res.status(400).json({ error: 'Select an account, connection and GitHub repository' });
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    const auth = res.locals.authSession as AuthSession;
    const timer = setTimeout(abort, Math.min(120000, Math.max(0, auth.expiresAt - Date.now())));
    try {
      const binding = deps.resolveBinding(input.data.accountId, input.data.model);
      if (input.data.requestId)
        return res.json(
          await deps.preview(
            binding,
            input.data.connectionId,
            input.data.repository,
            controller.signal,
            input.data.ordinaryRuntime,
            input.data.requestId,
          ),
        );
      return res.json(
        await deps.preview(
          binding,
          input.data.connectionId,
          input.data.repository,
          controller.signal,
          ...(input.data.ordinaryRuntime ? [input.data.ordinaryRuntime] : []),
        ),
      );
    } catch (error) {
      if (error instanceof RepositorySpaceError)
        return res.status(507).json({ code: 'repository_space', error: error.message });
      if (error instanceof RepositorySourceLimitError)
        return res.status(413).json({ code: 'repository_source_limit', error: error.message });
      return res.status(409).json({
        error:
          'Repository preview unavailable. Check the selected account, GitHub connection and repository access.',
      });
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
    }
  });
  router.post('/:id/prepare', requireSameOriginJson, async (req, res) => {
    const input = selection.safeParse(req.body);
    if (!input.success || !z.uuid().safeParse(req.params.id).success)
      return res.status(400).json({ error: 'Select a valid repository preview and account' });
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    const auth = res.locals.authSession as AuthSession;
    const timer = setTimeout(abort, Math.min(120000, Math.max(0, auth.expiresAt - Date.now())));
    try {
      const binding = deps.resolveBinding(input.data.accountId, input.data.model);
      return res.json(await deps.prepare(String(req.params.id), binding, controller.signal));
    } catch (error) {
      if (error instanceof RepositorySpaceError)
        return res.status(507).json({ code: 'repository_space', error: error.message });
      if (error instanceof RepositorySourceLimitError)
        return res.status(413).json({ code: 'repository_source_limit', error: error.message });
      return res.status(409).json({
        error: `Repository preparation unavailable. Refresh the preview if its commit or connection changed. Support is limited to regular files, 10,000 files and ${REPOSITORY_SOURCE_LIMIT_MIB} MiB of source.`,
      });
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
    }
  });
  router.get('/:id/chat-preparation', (req, res) => {
    if (
      !z.uuid().safeParse(req.params.id).success ||
      !z.strictObject({}).safeParse(req.query).success
    )
      return res.status(400).json({ error: 'Invalid repository chat preparation' });
    try {
      if (!deps.chatPreparation) throw new Error('unavailable');
      return res.json(deps.chatPreparation(String(req.params.id)));
    } catch {
      return res.status(404).json({ error: 'Repository chat preparation unavailable' });
    }
  });
  router.get('/:id', async (req, res) => {
    const input = selection.safeParse(req.query);
    if (!input.success || !z.uuid().safeParse(req.params.id).success)
      return res.status(400).json({ error: 'Invalid repository preparation' });
    try {
      if (!deps.status) throw new Error('unavailable');
      return res.json(
        await deps.status(
          String(req.params.id),
          deps.resolveBinding(input.data.accountId, input.data.model),
        ),
      );
    } catch {
      return res.status(404).json({ error: 'Repository preparation unavailable for this account' });
    }
  });
  const retirementAuthority = (
    auth: AuthSession,
    selected: z.infer<typeof selection>,
    binding: AccountBinding,
  ): RepositoryRetirementAuthorization => {
    const assertNative = deps.assertUnusedNativePreparation,
      assertStopped = deps.assertTaskStopped;
    return Object.freeze({
      assertCurrent: async () => {
        if (
          !isAuthSessionCurrent(auth) ||
          !isDeepStrictEqual(binding, deps.resolveBinding(selected.accountId, selected.model))
        )
          throw Error('Current retirement operator and account required');
      },
      ...(assertNative
        ? {
            assertUnusedNativePreparation: (record: Readonly<RepositoryWorkspace>) => {
              if (
                deps.assertUnusedNativePreparation !== assertNative ||
                !isAuthSessionCurrent(auth)
              )
                throw Error('Current native retirement authority required');
              assertNative(record);
            },
          }
        : {}),
      ...(assertStopped
        ? {
            assertTaskStopped: (record: Readonly<RepositoryWorkspace>) => {
              if (deps.assertTaskStopped !== assertStopped || !isAuthSessionCurrent(auth))
                throw Error('Current stopped task authority required');
              assertStopped(record);
            },
          }
        : {}),
    });
  };
  for (const action of ['retire', 'restore'] as const)
    router.post(`/:id/${action}`, requireSameOriginJson, async (req, res) => {
      const input = selection.safeParse(req.body);
      if (!input.success || !z.uuid().safeParse(req.params.id).success)
        return res.status(400).json({ error: 'Invalid repository task selection' });
      try {
        const effect = action === 'retire' ? deps.retireTask : deps.restoreTask;
        if (!effect || !deps.assertTaskStopped) throw Error('Task lifecycle owner unavailable');
        const binding = deps.resolveBinding(input.data.accountId, input.data.model);
        await effect(
          String(req.params.id),
          binding,
          retirementAuthority(res.locals.authSession as AuthSession, input.data, binding),
        );
        return res.json({ [action === 'retire' ? 'archived' : 'restored']: true });
      } catch {
        return res.status(409).json({
          error:
            action === 'retire'
              ? 'This task must be stopped with no queued work before it can be preserved and retired.'
              : 'The archived task could not be safely restored. Its preserved files have been retained.',
        });
      }
    });
  router.delete('/:id', requireSameOriginJson, async (req, res) => {
    const input = selection.safeParse(req.query);
    if (!input.success || !z.uuid().safeParse(req.params.id).success)
      return res.status(400).json({ error: 'Invalid repository preparation' });
    try {
      if (!deps.discard) throw new Error('unavailable');
      const binding = deps.resolveBinding(input.data.accountId, input.data.model);
      await deps.discard(
        String(req.params.id),
        binding,
        retirementAuthority(res.locals.authSession as AuthSession, input.data, binding),
      );
      return res.json({ discarded: true });
    } catch {
      return res
        .status(409)
        .json({ error: 'Only an unused repository preparation can be discarded' });
    }
  });
  return router;
}
