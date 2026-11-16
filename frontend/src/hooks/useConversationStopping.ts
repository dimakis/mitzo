import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { CollaborationApiClient } from '@mitzo/client';
import { CollaborationAgentStopInputSchema } from '@mitzo/protocol';
import { chatStorage, chatStorageKeys } from '../lib/large-chat-storage';
import { AUTH_LOST_EVENT } from '../lib/api-fetch';
import { createBrowserId } from '../lib/browser-crypto';

export interface ConversationStopTarget {
  messageId: string;
  deliveryId: string;
  sessionId: string;
  commandId: string;
  name: string;
}
const recordSchema = z.strictObject({
  group: z.string(),
  authScope: z.string(),
  name: z.string(),
  input: CollaborationAgentStopInputSchema.refine((input) => input.targets.length === 1),
  status: z.enum(['pending', 'requested', 'settled', 'uncertain', 'unavailable']),
});
type Record = z.infer<typeof recordSchema>;
const prefix = (group: string) => `mitzo-conversation-stop:${group}:`;
const storageKey = (record: Record) => prefix(record.group) + record.input.targets[0].deliveryId;

/** Controls one original native command per selected agent; never sends a prompt. */
export function useConversationStopping(options: {
  api: CollaborationApiClient;
  group?: string;
  authScope?: string;
  getVerifiedAuthScope(): string | undefined;
  membershipRevision?: number;
  memberIds: string[];
  targets: ConversationStopTarget[];
}) {
  const latest = useRef(options);
  latest.current = options;
  const scope = options.group + ':' + options.authScope;
  const owner = useRef({
    scope: '',
    records: [] as Record[],
    busy: false,
    blocked: false,
    generation: 0,
  });
  if (owner.current.scope !== scope) {
    const records: Record[] = [];
    let blocked = false;
    try {
      if (options.group)
        for (const key of chatStorageKeys().filter((key) =>
          key.startsWith(prefix(options.group!)),
        )) {
          const record = recordSchema.parse(JSON.parse(chatStorage.getItem(key)!));
          if (record.authScope === options.authScope && storageKey(record) === key)
            records.push(record);
          else blocked = true;
        }
    } catch (cause) {
      blocked = true;
      console.warn('Stop recovery unavailable', {
        code: 'collaboration_stop_recovery_failed',
        stage: 'read',
        cause: cause instanceof Error ? cause.name : typeof cause,
      });
    }
    owner.current = {
      scope,
      records,
      busy: false,
      blocked,
      generation: owner.current.generation + 1,
    };
  }
  const current = owner.current;
  const [, update] = useState(0);
  const [feedback, setFeedback] = useState<{ owner: object; message: string }>();
  const authorized = () =>
    !!latest.current.authScope &&
    latest.current.getVerifiedAuthScope() === latest.current.authScope;
  useEffect(() => {
    const lost = () => {
      current.generation++;
      update((n) => n + 1);
    };
    window.addEventListener(AUTH_LOST_EVENT, lost);
    return () => {
      current.generation++;
      window.removeEventListener(AUTH_LOST_EVENT, lost);
    };
  }, [current]);
  const persist = async (record: Record) => {
    const key = storageKey(record),
      previous = chatStorage.getItem(key);
    if (
      previous &&
      recordSchema.parse(JSON.parse(previous)).input.requestId !== record.input.requestId
    )
      throw Error('Stop recovery changed');
    const raw = JSON.stringify(recordSchema.parse(record));
    chatStorage.setItem(key, raw);
    await chatStorage.flush();
    if (chatStorage.failed || chatStorage.getItem(key) !== raw)
      throw Error('Stop recovery could not be retained');
    current.records = [...current.records.filter((r) => storageKey(r) !== key), record];
  };
  const execute = async (records: Record[]) => {
    if (!records.length || current.busy || current.blocked || !authorized()) return;
    current.busy = true;
    update((n) => n + 1);
    const generation = current.generation;
    const fresh = (record: Record) =>
      owner.current === current &&
      current.generation === generation &&
      authorized() &&
      record.group === latest.current.group &&
      record.authScope === latest.current.authScope &&
      latest.current.memberIds.includes(record.input.targets[0].sessionId);
    try {
      // Freeze every selected target before the first network effect. A reload
      // must recover the later targets with their original request identities.
      for (const record of records) await persist(record);
      for (const record of records) {
        if (!fresh(record)) return;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const result = await latest.current.api.stopAgents(
            record.group,
            record.input,
            controller.signal,
          );
          record.status = result.recipients[0]?.status ?? 'uncertain';
        } catch (cause) {
          record.status = 'uncertain';
          console.warn('Agent Stop needs reconciliation', {
            code: 'collaboration_stop_uncertain',
            stage: 'dispatch',
            requestId: record.input.requestId,
            sessionId: record.input.targets[0].sessionId,
            cause: cause instanceof Error ? cause.name : typeof cause,
          });
        } finally {
          clearTimeout(timer);
        }
        await persist(record);
        if (!fresh(record)) return;
        if (record.status === 'settled') {
          chatStorage.removeItem(storageKey(record));
          await chatStorage.flush();
          if (chatStorage.failed) throw Error('Stop cleanup could not be confirmed');
          current.records = current.records.filter((r) => storageKey(r) !== storageKey(record));
        }
      }
      setFeedback({
        owner: current,
        message: records.some((record) => ['uncertain', 'unavailable'].includes(record.status))
          ? 'Stop could not be confirmed for every selected agent. Check the original Stop.'
          : records.every((record) => record.status === 'settled')
            ? 'The selected commands have settled.'
            : 'Stop requested for the selected agents. Waiting for their commands to settle.',
      });
    } catch (cause) {
      current.blocked = true;
      console.warn('Stop recovery persistence failed', {
        code: 'collaboration_stop_persist_failed',
        stage: 'persist',
        cause: cause instanceof Error ? cause.name : typeof cause,
      });
      if (owner.current === current)
        setFeedback({
          owner: current,
          message: 'Could not retain Stop recovery. Keep this window open.',
        });
    } finally {
      current.busy = false;
      if (owner.current === current) update((n) => n + 1);
    }
  };
  return {
    busy: current.busy,
    pending: authorized() && current.records.length > 0,
    message: authorized()
      ? current.blocked
        ? 'Stop recovery is unavailable. Keep this window open and check the original operation.'
        : feedback?.owner === current
          ? feedback.message
          : undefined
      : undefined,
    outcomes: authorized() ? current.records : [],
    check: () => execute([...current.records]),
    stop: () => {
      if (
        !options.group ||
        !options.authScope ||
        options.membershipRevision === undefined ||
        !authorized()
      )
        return Promise.resolve();
      const records = options.targets.map(
        (target): Record =>
          current.records.find(
            (record) => record.input.targets[0].deliveryId === target.deliveryId,
          ) ??
          recordSchema.parse({
            group: options.group,
            authScope: options.authScope,
            name: target.name,
            status: 'pending',
            input: {
              requestId: createBrowserId(),
              expectedMembershipRevision: options.membershipRevision,
              targets: [
                {
                  messageId: target.messageId,
                  deliveryId: target.deliveryId,
                  sessionId: target.sessionId,
                  commandId: target.commandId,
                },
              ],
            },
          }),
      );
      return execute(records);
    },
  };
}
