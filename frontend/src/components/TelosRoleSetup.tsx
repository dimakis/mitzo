import './RepositoryChatPicker.css';
import { TelosLinkedContext } from './TelosLinkedContext';
import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { CollaborationSettingsSchema } from '@mitzo/protocol';
import { TelosWorkApiClient } from '@mitzo/client';
import { useTelosRoleSetup, type TelosRoleRouteIntent } from '../hooks/useTelosRoleSetup';
import type { useExplicitLocalChat } from '../hooks/useExplicitLocalChat';
import { prepareLocalFirstCommand } from '../lib/explicit-local-chat';
import { apiFetch } from '../lib/api-fetch';
import { createBrowserId } from '../lib/browser-crypto';

export function TelosRoleSetup({
  intent,
  runtime,
  repositoryWorkspaceId,
  mode,
  draftId,
  onBound,
  onLocked,
  beforeConfirm,
}: {
  intent: TelosRoleRouteIntent;
  runtime: ReturnType<typeof useExplicitLocalChat>;
  repositoryWorkspaceId?: string;
  mode: 'ask' | 'agent' | 'auto';
  draftId: string;
  onBound(id: string): void;
  onLocked(value: boolean): void;
  beforeConfirm(): boolean;
}) {
  const validationId = useRef<string | null>(null);
  validationId.current ??= createBrowserId();
  const api = useMemo(() => new TelosWorkApiClient(apiFetch), []);
  const settings = useMemo(() => {
    if (!repositoryWorkspaceId || runtime.reason) return null;
    const prepared = prepareLocalFirstCommand(runtime.intent, runtime.inventory, {
      clientMsgId: validationId.current!,
      repositoryWorkspaceId,
      mode,
      text: 'Review role chat settings',
    });
    if (!prepared.request) return null;
    const request = prepared.request;
    const targets = runtime.inventory?.targets.filter(
      (target) =>
        target.targetId === request.runtime.targetId &&
        target.harness === request.runtime.harness &&
        target.location === request.runOn,
    );
    if (targets?.length !== 1) return null;
    const parsed = CollaborationSettingsSchema.safeParse({
      binding: {
        version: 2,
        account: request.runtime.account,
        harness: { implementation: request.runtime.harness },
        execution: {
          location: request.runOn,
          targetId: targets[0].targetId,
          targetRevision: targets[0].targetRevision,
        },
      },
      selection: request.selection,
      repositoryWorkspaceId,
    });
    return parsed.success ? parsed.data : null;
  }, [runtime.intent, runtime.inventory, runtime.reason, repositoryWorkspaceId, mode]);
  const setup = useTelosRoleSetup({ draftId, intent, settings, api, onBound });
  const reopened = useRef<string | null>(null);
  useEffect(() => {
    if (!setup.boundConversationId) return;
    const key = `${draftId}:${setup.boundConversationId}`;
    if (reopened.current === key) return;
    reopened.current = key;
    onBound(setup.boundConversationId);
  }, [setup.boundConversationId, draftId, onBound]);
  const { pending, locked, uncertain, rejectedBeforeAllocation, review } = setup;
  const reviewKey = JSON.stringify({ intent, settings });
  const reviewed = useRef<string | null>(null);
  useEffect(() => {
    onLocked(setup.locked);
    return () => onLocked(false);
  }, [setup.locked, onLocked]);
  useEffect(() => {
    if (
      !settings ||
      pending ||
      locked ||
      uncertain ||
      rejectedBeforeAllocation ||
      reviewed.current === reviewKey
    )
      return;
    reviewed.current = reviewKey;
    void review();
  }, [reviewKey, settings, pending, locked, uncertain, rejectedBeforeAllocation, review]);
  const label =
    intent.mode === 'assign' && intent.role === 'lead'
      ? 'Assign lead & open chat'
      : intent.mode === 'assign' && intent.role === 'worker'
        ? 'Assign worker & open chat'
        : 'Start chat';
  return (
    <section
      className="repository-chat-picker chat-launch-prompt"
      aria-label="Work conversation setup"
    >
      <p>
        <Link to={`/todos/${encodeURIComponent(intent.itemId)}`}>Work item</Link> ·{' '}
        {intent.role === 'advisor'
          ? intent.purpose === 'child'
            ? 'Add child'
            : 'Refine item'
          : intent.role[0].toUpperCase() + intent.role.slice(1)}
      </p>
      {setup.replacing && (
        <p>
          Choose a replacement using ordinary chat settings. The previous conversation stays linked.
        </p>
      )}
      {intent.mode === 'additional' && (
        <p>
          Start another conversation for this same item. Its assigned worker and existing chats stay
          linked.
        </p>
      )}
      {intent.role === 'lead' && (
        <p>
          Collaborate on the plan, maintain the brief, delegate each slice to its own worker chat,
          coordinate dependencies and review returned evidence.
        </p>
      )}
      <p>Choose the ordinary chat settings above. Opening this chat does not send a message.</p>
      {setup.context && (
        <TelosLinkedContext
          context={setup.context}
          presentation={setup.presentation}
          presentationRef={setup.presentationRef}
          summary="Linked work context"
        />
      )}
      {setup.error && <p role="alert">{setup.error}</p>}
      {!settings && (
        <p role="status">Choose supported chat settings and a repository to continue.</p>
      )}
      {setup.pending && (
        <p role="status">
          {setup.pending === 'review' ? 'Loading linked context…' : 'Preparing chat…'}
        </p>
      )}
      <button
        className="btn-primary"
        type="button"
        disabled={
          !!setup.pending ||
          (!setup.boundConversationId &&
            !setup.uncertain &&
            !setup.canConfirm &&
            !(setup.error && settings))
        }
        onClick={() => {
          if (setup.boundConversationId) onBound(setup.boundConversationId);
          else if (beforeConfirm()) {
            // Explicit review already owns this settings key. Do not immediately
            // repeat it when the terminal-rejection state becomes reviewed.
            if (setup.rejectedBeforeAllocation) reviewed.current = reviewKey;
            void (setup.uncertain || setup.error ? setup.retry() : setup.confirm());
          }
        }}
      >
        {setup.rejectedBeforeAllocation ? 'Review updated brief' : label}
      </button>
    </section>
  );
}
