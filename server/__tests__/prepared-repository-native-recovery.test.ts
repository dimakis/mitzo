import { fixture, cleanups, git } from './fixtures/prepared-repository-native-consumer.js';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { OrdinaryLocalCodexOwnedRuntime } from '../ordinary-local-codex-owned-runtime.js';
import { RetainedLocalCodexRecovery } from '../retained-local-codex-recovery.js';
import { executeTrustedGitCommit } from '../trusted-native-operation.js';

it.each(['new-input', 'exact-retained-input', 'saved-retained-input'] as const)(
  'cold-resumes a workspace revision with %s and held explicit work without an automatic primary',
  async (mode) => {
    const f = await fixture(false, 300000);
    const followup = {
      ...structuredClone(f.request),
      clientMsgId: 'held-before-retirement',
      payload: { text: 'Explain the retained edits before doing more' },
    };
    await f.runtime.admitContinuation(followup);
    const originalAdmission = f.events.getOrdinaryLocalCommandAdmission(followup.clientMsgId);
    const result = await f.adopt();
    f.setCwd(result!.directory);
    const retainedThread = f.native.read(f.first.sessionId, f.first.lease.binding).threadId;
    f.runtime.close();
    const request =
      mode === 'new-input'
        ? {
            ...structuredClone(f.request),
            clientMsgId: 'cold-after-held-steering',
            payload: { text: 'Continue this same conversation' },
          }
        : followup;
    const dispatch = vi.fn(
      async (
        value: import('../ordinary-local-codex-owned-runtime.js').OrdinaryLocalCodexOwnedDispatch,
      ) => {
        await value.admission.assertCurrent();
        expect(value.admission.nativeExecutionWorkspace(followup.clientMsgId).cwd).toBe(
          result!.directory,
        );
        value.admission.assertBeforeEnqueue({
          id: value.commandId,
          prompt: value.payload.text,
          intent: value.payload.intent,
          model: value.expected.selection.model,
          reasoningEffort: value.expected.selection.thinking,
        });
        f.native.enqueue(value.sessionId, value.lease.binding, {
          id: value.commandId,
          prompt: value.payload.text,
          intent: value.payload.intent,
          model: value.expected.selection.model,
          reasoningEffort: value.expected.selection.thinking,
        });
      },
    );
    const cold = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: f.native,
      commandId: request.clientMsgId,
      reservation: { ...f.reservation, id: result!.id },
      launch: () => ({ ...f.rpc, close: vi.fn() }),
      dispatch,
    });
    cleanups.push(() => cold.close());
    await expect(
      mode === 'new-input'
        ? cold.admitResume(request)
        : mode === 'exact-retained-input'
          ? cold.recoverResume(request)
          : cold.recoverSavedResume(),
    ).resolves.toEqual({ dispatched: true });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.native.read(f.first.sessionId, f.first.lease.binding).threadId).toBe(retainedThread);
    expect(
      f.native
        .commands(f.first.sessionId, f.first.lease.binding)
        .filter((command) => command.status === 'queued')
        .map((command) => command.id),
    ).toEqual(
      mode === 'new-input' ? [followup.clientMsgId, request.clientMsgId] : [followup.clientMsgId],
    );
    if (mode !== 'new-input') {
      const execution = f.events.getOrdinaryLocalCommandExecutionAdmission(followup.clientMsgId)!;
      const primary = execution.preparedRepositoryPrimaryCommandId!;
      expect(
        f.events.getPreparedRepositoryCommandAdmissionEvidence(followup.clientMsgId, primary),
      ).toEqual(originalAdmission);
      expect(
        f.events.observePreparedRepositoryColdBootstrapAdmission(
          primary,
          followup.clientMsgId,
          primary,
        ),
      ).toEqual(execution);
      const queued = f.native.claimNext(f.first.sessionId, f.first.lease.binding)!;
      expect(queued.id).toBe(followup.clientMsgId);
      dispatch.mock.calls[0][0].admission.assertBeforeDispatch(queued.id);
      // Recovery's rebound primary must also retain the adopted checkout's
      // commit authority through the real validator and trusted executor.
      await writeFile(join(result!.directory, 'recovered.txt'), 'Reviewed recovered work');
      await writeFile(join(result!.directory, 'unselected.txt'), 'Retain dirty work');
      const task = await f.workspace.validateHostTask(f.first.sessionId, result!.directory);
      await executeTrustedGitCommit(
        result!.directory,
        ['recovered.txt'],
        'fix: retained recovered work',
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        task,
      );
      expect(git(result!.directory, 'show', '--format=', '--name-only', 'HEAD')).toBe(
        'recovered.txt',
      );
      expect(git(result!.directory, 'status', '--porcelain')).toContain('?? unselected.txt');
      expect(
        (await f.workspace.validateHostTask(f.first.sessionId, result!.directory)).directory,
      ).toBe(result!.directory);
    }
  },
);

it.each(['before-enqueue', 'after-enqueue'] as const)(
  'recovers uncertain explicit input admitted under an adopted primary %s',
  async (phase) => {
    const f = await fixture();
    const adopted = await f.adopt();
    f.setCwd(adopted!.directory);
    f.runtime.close();
    const request = {
      ...structuredClone(f.request),
      clientMsgId: `uncertain-adopted-${phase}`,
      payload: { text: 'Retain my new adopted-workspace request' },
    };
    const dispatch = vi.fn(
      async (
        value: import('../ordinary-local-codex-owned-runtime.js').OrdinaryLocalCodexOwnedDispatch,
      ) => {
        if (phase === 'after-enqueue') {
          const input = {
            id: value.commandId,
            prompt: value.payload.text,
            intent: value.payload.intent,
            model: value.expected.selection.model,
            reasoningEffort: value.expected.selection.thinking,
          };
          value.admission.assertBeforeEnqueue(input);
          f.native.enqueue(value.sessionId, value.lease.binding, input);
        }
        throw Error('Offline failure before native dispatch');
      },
    );
    const cold = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: f.native,
      commandId: request.clientMsgId,
      reservation: { ...f.reservation, id: adopted!.id },
      launch: () => ({ ...f.rpc, close: vi.fn() }),
      dispatch,
    });
    cleanups.push(() => cold.close());
    await expect(cold.admitResume(request)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledOnce();
    cold.close();
    const original = f.events.getOrdinaryLocalCommandExecutionAdmission(request.clientMsgId)!;
    expect(original.state).toBe('uncertain');
    expect(original.preparedRepositoryPrimaryCommandId).toBeTruthy();
    expect(() =>
      RetainedLocalCodexRecovery.capture(f.events, f.native, f.first.sessionId, f.auth.id, request),
    ).not.toThrow();
    expect(f.events.getOrdinaryLocalCommandExecutionAdmission(request.clientMsgId)).toEqual(
      original,
    );
    expect(
      f.native
        .commands(f.first.sessionId, f.first.lease.binding)
        .filter((row) => row.id === request.clientMsgId),
    ).toHaveLength(phase === 'after-enqueue' ? 1 : 0);
  },
);
