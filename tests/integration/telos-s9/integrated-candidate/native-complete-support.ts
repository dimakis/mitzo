import { expect, vi } from 'vitest';
import { expect as browserExpect, type Page } from '@playwright/test';
import type { AgentLibraryStore } from '../../../../server/agent-library-store.js';
import { prepareNativeProviderToolCall } from '../../../../server/__tests__/fixtures/native-provider-tool-call.js';

const originalFetch = globalThis.fetch;
export type NativeCompleteFact = { stage: string; facts: unknown };
type Actor = Parameters<typeof prepareNativeProviderToolCall>[0];
type Result = { success: boolean; contentItems: Array<{ type: string; text?: string }> };

// An advisor has no delegated Task Board task. Publish its real tool ceiling
// separately, before setup, rather than inheriting the lead/worker selection.
export function publishNativeCompleteAdvisorProfile(library: AgentLibraryStore) {
  const draft = library.saveDraft('user', {
    profileId: 's9-native-complete-advisor',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'native-complete-advisor-draft',
    definition: {
      name: 'S9 complete journey advisor',
      role: 'agent',
      instructions: 'Retain the reviewed plan; execution is a separate decision.',
      expectedOutput: 'A retained advisory narrative.',
      acceptanceCriteria: ['Preserve the original advisor and source context.'],
      modelPolicyRole: 'agent',
      tools: [{ id: 'mitzo:Read', version: 1 }],
    },
  });
  return library.publish('user', {
    profileId: draft.profileId,
    expectedVersion: draft.version,
    idempotencyKey: 'native-complete-advisor-publish',
  });
}

// Synthetic fixture publication precedes role selection. Never edit a session's
// retained profile, native admission, permissions or role/context after setup.
export function publishNativeCompleteProfile(library: AgentLibraryStore) {
  const draft = library.saveDraft('user', {
    profileId: 's9-native-complete-worker',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'native-complete-profile-draft',
    definition: {
      name: 'S9 complete native journey',
      role: 'agent',
      instructions: 'Keep the original reviewed role, exact task and source authority.',
      expectedOutput: 'Exact retained worker report, subject to independent review.',
      acceptanceCriteria: ['Keep execution-task approval distinct from canonical completion.'],
      modelPolicyRole: 'agent',
      tools: [
        'Write',
        'Read',
        'TelosStartSlice',
        'TelosSaveArtifact',
        'TelosReadArtifact',
        'TelosAdoptSource',
        'TelosGetItem',
        'TelosUpdateItem',
        'TaskStatus',
        'TaskArtifact',
        'TaskComplete',
      ].map((name) => ({ id: 'mitzo:' + name, version: 1 })),
    },
  });
  return library.publish('user', {
    profileId: draft.profileId,
    expectedVersion: draft.version,
    idempotencyKey: 'native-complete-profile-publish',
  });
}

// Only the two original native loopback callbacks are allowed. All other
// external effects/model traffic continue to fail closed in these cases.
export function allowNativeCompleteCallbacks(origin: string) {
  const ownedOrigins = [origin, `http://localhost:${new URL(origin).port}`];
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      !ownedOrigins.includes(url.origin) ||
      init?.method !== 'POST' ||
      url.username ||
      url.password ||
      url.hash ||
      !['/api/internal/telos/work/delegate', '/api/internal/telos/source/execute'].includes(
        url.pathname,
      )
    )
      throw Error('Only reviewed private native callbacks are permitted');
    return originalFetch(input, { ...init, redirect: 'error' });
  });
}

export function nativeCompleteCaller(
  page: Page,
  messages: Record<string, unknown>[],
  facts: NativeCompleteFact[],
) {
  return async (
    actor: Actor,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    decision: 'once' | 'deny' | 'exact-save-retry' | 'refuse-before-approval' = 'once',
    beforeDecision?: () => Promise<void>,
  ) => {
    const prepared = await prepareNativeProviderToolCall(actor, name, args);
    facts.push({ stage: 'native-provider-input', facts: { sessionId, name, ...prepared } });
    if (name.startsWith('mcp__')) {
      expect(prepared.contract?.name).toBe(name);
      expect(prepared.request.tool).toBe('InvokeIntegrationTool');
    } else expect(prepared.request.tool).toBe(name);
    const before = messages.length;
    let result: Result | undefined, failure: unknown;
    const pending = actor.lifecycle
      .onRequest('item/tool/call', prepared.request, new AbortController().signal)
      .then(
        (value) => {
          result = value as Result;
        },
        (error) => {
          failure = error;
        },
      );
    const permission = () =>
      messages
        .slice(before)
        .find(
          (message) => message.type === 'permission_request' && message.sessionId === sessionId,
        );
    await vi.waitFor(() => expect(result || failure || permission()).toBeTruthy(), {
      timeout: 10_000,
    });
    const prompt = permission();
    if (decision === 'refuse-before-approval' || decision === 'exact-save-retry') {
      expect(name).toBe(
        decision === 'exact-save-retry' ? 'TelosSaveArtifact' : 'TelosReadArtifact',
      );
      expect(prompt).toBeUndefined();
      expect(beforeDecision).toBeUndefined();
    } else {
      expect(prompt).toBeTruthy();
      expect(prompt!.toolName).toBe(name);
      if (
        [
          'TelosSaveArtifact',
          'TelosReadArtifact',
          'TelosAdoptSource',
          'TelosGetItem',
          'TelosUpdateItem',
        ].includes(name)
      )
        expect(prompt).toMatchObject({ approvalScope: 'request', allowSessionGrant: false });
      facts.push({
        stage: 'real-browser-permission',
        facts: { sessionId, name, decision, prompt },
      });
      await beforeDecision?.();
      const button = page.getByRole('button', {
        name: decision === 'deny' ? 'Deny' : 'Allow Once',
        exact: true,
      });
      await browserExpect(button).toBeVisible();
      await button.click();
    }
    await pending;
    if (failure) throw failure;
    expect(result).toBeTruthy();
    facts.push({ stage: 'native-provider-result', facts: { sessionId, name, result } });
    return result!;
  };
}

export function nativeCompleteJSON(result: Result): Record<string, unknown> {
  return JSON.parse(result.contentItems.map((item) => item.text ?? '').join('')) as Record<
    string,
    unknown
  >;
}
