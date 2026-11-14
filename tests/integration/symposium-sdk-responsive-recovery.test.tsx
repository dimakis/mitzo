// @vitest-environment node-compatible-dom
import { expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  journey,
  sdkApplicationState,
} from '../../server/__tests__/fixtures/symposium-claude-application';
import { installDialogStub } from '../../frontend/src/components/__tests__/dialog-stub';
import { applicationEventSource } from '../support/application-event-source';
import { mountResponsiveOrdinary } from '../support/ordinary-responsive-composition';

// Independent screen/transport extension of the owner's SDK fixture. Only its
// external account/SDK process and input authority wait are deterministic;
// ResponsiveChatView, HTTP/SSE auth, preparation/admission, Stop and Check remain real.
it('recovers pre-input SDK cancellation through actual responsive ordinary chat without a provider turn or replay', async () => {
  console.info(
    'SDK_RESPONSIVE_SOURCE',
    JSON.stringify({
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      branch:
        execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() ||
        'detached HEAD',
      testSha256: createHash('sha256')
        .update(await readFile(new URL(import.meta.url)))
        .digest('hex'),
      compositionHelperSha256: createHash('sha256')
        .update(
          await readFile(
            new URL('../support/ordinary-responsive-composition.tsx', import.meta.url),
          ),
        )
        .digest('hex'),
      externalFixtureSha256: createHash('sha256')
        .update(
          await readFile(
            new URL(
              '../../server/__tests__/fixtures/symposium-claude-application.ts',
              import.meta.url,
            ),
          ),
        )
        .digest('hex'),
      applicationTransportSha256: createHash('sha256')
        .update(await readFile(new URL('../support/application-event-source.ts', import.meta.url)))
        .digest('hex'),
      ordinarySdkEvidenceSha256: createHash('sha256')
        .update(
          await readFile(new URL('../../server/ordinary-sdk-turn-evidence.ts', import.meta.url)),
        )
        .digest('hex'),
      route: '/chat/existing-chat',
      widths: [390, 320, 1280],
      node: process.version,
      build: 'Vitest source transpilation; JSDOM, no geometry qualification',
    }),
  );
  const observed = sdkApplicationState();
  const h = await journey.getApplicationUiJourney();
  (await import('../../server/auth')).setAuthRevocationStore(h.events);
  const participant = h.joinedSessionId;
  let transport: Awaited<ReturnType<typeof applicationEventSource>> | undefined;
  let mounted: Awaited<ReturnType<typeof mountResponsiveOrdinary>> | undefined;
  let stage = 'warm_and_mount';
  let diagnosticCommand = '';
  try {
    let view = await h.api.view(h.group);
    for (const policy of view.policies.filter((entry) => entry.readsFutureDiscussion)) {
      await h.api.setPolicy(h.group, {
        requestId: crypto.randomUUID(),
        expectedMembershipRevision: view.membershipRevision,
        expectedRevision: policy.revision,
        sessionId: policy.sessionId,
        readsFutureDiscussion: false,
        repliesByDefault: false,
      });
    }
    view = await h.api.view(h.group);
    const warm = {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedPolicySequence: view.policySequence,
      text: 'Independent SDK owner qualification',
      responders: { kind: 'selected' as const, sessionIds: [participant] },
      snapshot: null,
    };
    const warmReceipt = await h.api.send(h.group, warm);
    await vi.waitFor(
      async () => expect((await h.api.observeSend(h.group, warm)).terminal).toBe(true),
      { timeout: 10000 },
    );
    const drafts = await import('../../frontend/src/lib/chat-drafts');
    const draft = drafts.createChatDraft();
    expect(
      drafts.saveChatDraft({
        ...draft,
        id: 'shared:' + h.group,
        settings: {
          ...draft.settings,
          collaborationResponders: {
            collaborationId: h.group,
            responders: { kind: 'selected', sessionIds: [participant] },
          },
        },
      }),
    ).toBe(true);
    transport = await applicationEventSource(journey.state.app, journey.state.cookie);
    vi.stubGlobal('fetch', h.fetch);
    vi.stubGlobal('addEventListener', window.addEventListener.bind(window));
    vi.stubGlobal('removeEventListener', window.removeEventListener.bind(window));
    vi.stubGlobal('HTMLDialogElement', window.HTMLDialogElement);
    installDialogStub();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'EventSource',
      class extends EventTarget {
        readyState = 0;
        onopen = null;
        onerror = null;
        close() {}
      },
    );
    HTMLElement.prototype.scrollTo = () => {};
    HTMLElement.prototype.scrollIntoView = () => {};
    expect(
      await (await import('../../frontend/src/lib/api-fetch')).restoreCookieAuthentication(),
    ).toBe(true);
    mounted = await mountResponsiveOrdinary({
      api: h.typedApi,
      transport,
      source: 'existing-chat',
      width: 390,
    });
    const input = await waitFor(() => {
      const field = screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
      expect(field.disabled).toBe(false);
      expect(field.closest('.chat-input-host')).not.toBeNull();
      return field;
    });
    const before = { inputs: observed.inputs.length, interrupts: observed.interrupts };
    const recipients = screen
      .getByRole('button', { name: 'Choose who replies' })
      .getAttribute('title');
    await userEvent.type(input, 'Independent Stop before SDK input acceptance');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    observed.holdInputAuthority = true;
    stage = 'hold_before_sdk_input';
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await vi.waitFor(() => expect(observed.releaseInput).toBeTypeOf('function'), {
      timeout: 10000,
    });
    await screen.findByRole('button', { name: 'Stop generation' });
    const message = (await h.api.view(h.group)).messages.find(
      (entry) => entry.text === 'Independent Stop before SDK input acceptance',
    )!;
    const commandId = message.deliveries.find(
      (delivery) => delivery.sessionId === participant,
    )!.commandId!;
    diagnosticCommand = commandId;
    const original = drafts.getChatDraft('shared:' + h.group)!.collaborationSend!.input;
    expect(commandId).toBeTruthy();
    stage = 'stop_before_input_yield';
    await userEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
    await vi.waitFor(() =>
      expect(h.events.getSession(participant)?.executionPhase).toBe('STOPPING'),
    );
    await userEvent.clear(input);
    const later = 'Independent draft survives cancelled SDK input';
    await userEvent.type(input, later);
    input.focus();
    input.setSelectionRange(3, 18);
    for (const width of [320, 1280]) {
      act(() => mounted!.resize(width));
      expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(input);
      expect(input.value).toBe(later);
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 18]);
      expect(screen.getByRole('button', { name: 'Choose who replies' }).getAttribute('title')).toBe(
        recipients,
      );
      expect(mounted.ui.container.querySelectorAll('.chat-messages')).toHaveLength(1);
    }
    await act(async () => observed.releaseInput!());
    stage = 'positive_cancellation_receipt';
    await vi.waitFor(() =>
      expect(h.events.getSendCommand(commandId)?.error).toBe('Cancelled before SDK dispatch'),
    );
    stage = 'visible_check_original';
    if (!screen.queryByRole('button', { name: 'Check original request' })) {
      fireEvent.click(screen.getByRole('button', { name: 'Conversation status details' }));
    }
    await userEvent.click(await screen.findByRole('button', { name: 'Check original request' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull(),
    );
    const receipt = await h.api.observeSend(h.group, original);
    stage = 'terminal_exact_receipt';
    expect(receipt.terminal).toBe(true);
    expect(receipt.message?.messageId).toBe(message.messageId);
    expect(receipt.message?.deliveries.map((entry) => entry.commandId)).toEqual(
      message.deliveries.map((entry) => entry.commandId),
    );
    expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(input);
    expect(input.value).toBe(later);
    await waitFor(() =>
      expect(drafts.getChatDraft('shared:' + h.group)?.collaborationSend).toBeUndefined(),
    );
    expect(h.events.getOrdinarySdkTurnEvents(participant, commandId)).toEqual([]);
    expect(h.events.getOrdinaryProviderTurnTerminal(participant, commandId)).toBeUndefined();
    expect((await h.api.send(h.group, original)).messageId).toBe(message.messageId);
    expect((await h.api.send(h.group, warm)).messageId).toBe(warmReceipt.messageId);
    expect(observed.inputs).toHaveLength(before.inputs);
    expect(observed.interrupts).toBe(before.interrupts);
    const sameTextareaBeforeRestart =
      screen.getByRole('textbox', { name: 'Message Mitzo' }) === input;
    mounted.close();
    mounted = undefined;
    await transport.close();
    transport = undefined;
    observed.holdInputAuthority = false;
    const oldChat = await import('../../server/chat');
    for (const [clientId] of [...oldChat.registry.entries(true)]) oldChat.registry.abort(clientId);
    (await import('../../frontend/src/lib/event-bus-singleton')).eventBus.disconnect();
    await vi.waitFor(async () =>
      (await import('../../server/repository-workspace-runtime'))
        .getRepositoryWorkspaces(true)
        .closeIdle(),
    );
    await vi.waitFor(() => journey.restartApplication(), { timeout: 10000 });
    stage = 'restored_receipt_and_composer';
    const reopened = await journey.getApplicationUiJourney();
    (await import('../../server/auth')).setAuthRevocationStore(reopened.events);
    const retained = await reopened.api.observeSend(reopened.group, original);
    expect(retained.terminal).toBe(true);
    expect(retained.message?.messageId).toBe(message.messageId);
    expect(retained.message?.deliveries.map((entry) => entry.commandId)).toEqual(
      message.deliveries.map((entry) => entry.commandId),
    );
    expect(reopened.events.getOrdinarySdkTurnEvents(participant, commandId)).toEqual([]);
    expect(reopened.events.getOrdinaryProviderTurnTerminal(participant, commandId)).toBeUndefined();
    transport = await applicationEventSource(journey.state.app, journey.state.cookie);
    vi.stubGlobal('fetch', reopened.fetch);
    expect(
      await (await import('../../frontend/src/lib/api-fetch')).restoreCookieAuthentication(),
    ).toBe(true);
    mounted = await mountResponsiveOrdinary({
      api: reopened.typedApi,
      transport,
      source: 'existing-chat',
      width: 390,
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement).value,
      ).toBe(later),
    );
    expect(observed.inputs).toHaveLength(before.inputs);
    expect(observed.interrupts).toBe(before.interrupts);
    console.info(
      'SDK_RESPONSIVE_COMPLETE',
      JSON.stringify({
        participant,
        commandId,
        requestId: original.requestId,
        messageId: message.messageId,
        terminal: receipt.terminal,
        additionalProviderInputs: observed.inputs.length - before.inputs,
        additionalProviderInterrupts: observed.interrupts - before.interrupts,
        sameTextareaBeforeRestart,
        restoredDraftAfterApplicationRestart: true,
        widths: [390, 320, 1280],
        physicalDevice: 'unobserved',
      }),
    );
  } catch (error) {
    console.error(
      'SDK_RESPONSIVE_DIAGNOSTIC',
      JSON.stringify({
        stage,
        participant,
        commandId: diagnosticCommand,
        executionPhase: journey.state.events.getSession(participant)?.executionPhase,
        sdkInputCount: observed.inputs.length,
        sdkInterruptCount: observed.interrupts,
        sdkTurnEvents: diagnosticCommand
          ? journey.state.events
              .getOrdinarySdkTurnEvents(participant, diagnosticCommand)
              .map((event) => event.type)
          : [],
      }),
    );
    throw error;
  } finally {
    observed.holdInputAuthority = false;
    observed.releaseInput?.();
    mounted?.close();
    cleanup();
    await transport?.close();
    const chat = await import('../../server/chat');
    for (const [clientId] of [...chat.registry.entries(true)]) chat.registry.abort(clientId);
    (await import('../../frontend/src/lib/event-bus-singleton')).eventBus.disconnect();
    await vi.waitFor(async () =>
      (await import('../../server/repository-workspace-runtime'))
        .getRepositoryWorkspaces(true)
        .closeIdle(),
    );
    // Registry abort and final HTTP reads settle through their actual owners.
    // The fixture afterAll closes its HTTP bridge and removes the root only
    // after this real idle-release fence succeeds.
    await vi.waitFor(() => journey.state.close!(), { timeout: 10000 });
  }
}, 60000);
