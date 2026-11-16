import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { CodexSteerInputSchema, type ImageAttachment } from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT } from '../lib/api-fetch';
import { chatStorage } from '../lib/large-chat-storage';
import { createBrowserId } from '../lib/browser-crypto';

export interface ConversationSteeringTarget {
  sessionId: string;
  name: string;
  commandId: string;
}
const outcome = z.enum(['pending', 'accepted', 'rejected', 'stale_target', 'uncertain']);
const batch = z.strictObject({
  version: z.literal(1),
  requestId: z.string(),
  group: z.string(),
  authScope: z.string(),
  targets: z
    .array(
      z.strictObject({
        sessionId: z.string(),
        name: z.string(),
        input: CodexSteerInputSchema,
        status: outcome,
      }),
    )
    .min(1)
    .max(16),
});
type Batch = z.infer<typeof batch>;
const savedBatches = z
  .union([batch, z.array(batch).max(100)])
  .transform((value) => (Array.isArray(value) ? value : [value]));
const terminal = (status: string) => ['accepted', 'rejected', 'stale_target'].includes(status);
const key = (group: string) => `mitzo-conversation-steering:${group}`;

/** Explicit exact-command corrections. Uncertainty keeps every original per-agent ID. */
export function useConversationSteering(options: {
  group?: string;
  authScope?: string;
  getVerifiedAuthScope(): string | undefined;
  memberIds: string[];
  targets: ConversationSteeringTarget[];
}) {
  const latest = useRef(options);
  latest.current = options;
  const scope = options.group + ':' + options.authScope;
  const state = useRef<{
    scope: string;
    values: Batch[];
    blocked: boolean;
    busy: boolean;
    generation: number;
  }>({ scope: '', values: [], blocked: false, busy: false, generation: 0 });
  if (state.current.scope !== scope) {
    let values: Batch[] = [],
      blocked = false;
    try {
      const saved = options.group && chatStorage.getItem(key(options.group));
      if (saved) values = savedBatches.parse(JSON.parse(saved));
      if (
        values.some(
          (value) => value.group !== options.group || value.authScope !== options.authScope,
        )
      )
        blocked = true;
    } catch (cause) {
      blocked = true;
      console.warn('Correction recovery unavailable', {
        code: 'collaboration_steering_recovery_failed',
        stage: 'read',
        cause: cause instanceof Error ? cause.name : typeof cause,
      });
    }
    state.current = {
      scope,
      values,
      blocked,
      busy: false,
      generation: state.current.generation + 1,
    };
  }
  const current = state.current;
  const [, update] = useState(0);
  const [feedback, setFeedback] = useState<{
    owner: object;
    message: string;
    outcomes: Batch['targets'];
  }>();
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
  const authorized = () =>
    !!latest.current.authScope &&
    latest.current.getVerifiedAuthScope() === latest.current.authScope;
  const save = async (value: Batch) => {
    const parsed = batch.parse(value);
    const saved = chatStorage.getItem(key(value.group));
    const values = saved ? savedBatches.parse(JSON.parse(saved)) : [];
    const previous = values.find((record) => record.requestId === value.requestId);
    if (
      previous &&
      (previous.group !== value.group ||
        previous.authScope !== value.authScope ||
        JSON.stringify(previous.targets.map((target) => target.input)) !==
          JSON.stringify(value.targets.map((target) => target.input)))
    )
      throw Error('Correction identity changed');
    const next = [...values.filter((record) => record.requestId !== value.requestId), parsed];
    if (next.length > 100) throw Error('Too many corrections need recovery');
    chatStorage.setItem(key(value.group), JSON.stringify(next));
    await chatStorage.flush();
    if (chatStorage.failed || chatStorage.getItem(key(value.group)) !== JSON.stringify(next))
      throw Error('Correction recovery could not be retained');
    current.values = next;
  };
  const execute = async (original: Batch) => {
    if (current.busy || current.blocked || !authorized()) return false;
    current.busy = true;
    update((n) => n + 1);
    const generation = current.generation;
    const fresh = () =>
      state.current === current &&
      current.generation === generation &&
      authorized() &&
      original.authScope === latest.current.authScope &&
      original.group === latest.current.group &&
      original.targets.every((target) => latest.current.memberIds.includes(target.sessionId));
    try {
      await save(original);
      if (!fresh()) return false;
      for (const target of original.targets) {
        if (terminal(target.status)) continue;
        if (!fresh()) return false;
        let status: z.infer<typeof outcome> = 'uncertain';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await apiFetch(
            `/api/sessions/${encodeURIComponent(target.sessionId)}/codex-queue/steer`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(target.input),
              signal: controller.signal,
            },
          );
          const receipt = z
            .object({ requestId: z.string(), status: outcome })
            .safeParse(await response.json());
          if (
            receipt.success &&
            receipt.data.requestId === target.input.requestId &&
            receipt.data.status !== 'pending'
          )
            status = receipt.data.status;
        } catch (cause) {
          console.warn('Agent correction needs reconciliation', {
            code: 'collaboration_steering_uncertain',
            stage: 'dispatch',
            sessionId: target.sessionId,
            requestId: target.input.requestId,
            cause: cause instanceof Error ? cause.name : typeof cause,
          });
        } finally {
          clearTimeout(timer);
        }
        target.status = status;
        // Retain the outcome even when authorization was lost after native input.
        await save(original);
        if (!fresh()) return false;
      }
      const complete = original.targets.every((target) => terminal(target.status));
      if (complete) {
        const saved = chatStorage.getItem(key(original.group));
        const values = saved ? savedBatches.parse(JSON.parse(saved)) : [];
        if (!values.some((value) => value.requestId === original.requestId))
          throw Error('Correction recovery changed');
        const remaining = values.filter((value) => value.requestId !== original.requestId);
        if (remaining.length) chatStorage.setItem(key(original.group), JSON.stringify(remaining));
        else chatStorage.removeItem(key(original.group));
        await chatStorage.flush();
        if (chatStorage.failed) throw Error('Correction cleanup could not be confirmed');
        current.values = remaining;
      }
      const accepted = original.targets.every((target) => target.status === 'accepted');
      setFeedback({
        owner: current,
        outcomes: structuredClone(original.targets),
        message: accepted
          ? 'Correction accepted by the selected agents.'
          : complete
            ? 'Some agents could not accept the correction. Your draft is retained.'
            : 'Correction delivery is uncertain. Check the original correction.',
      });
      return accepted;
    } catch (cause) {
      current.blocked = true;
      console.warn('Agent correction recovery failed', {
        code: 'collaboration_steering_persist_failed',
        stage: 'persist',
        requestId: original.requestId,
        cause: cause instanceof Error ? cause.name : typeof cause,
      });
      if (state.current === current)
        setFeedback({
          owner: current,
          outcomes: original.targets,
          message: 'Could not retain correction recovery. Keep this window open and your draft.',
        });
      return false;
    } finally {
      current.busy = false;
      if (state.current === current) update((n) => n + 1);
    }
  };
  const conflicts = current.values.some((value) =>
    value.targets.some(
      (target) =>
        !terminal(target.status) &&
        options.targets.some((selected) => selected.sessionId === target.sessionId),
    ),
  );
  return {
    pending: authorized() && current.values.length > 0,
    busy: current.busy,
    reason: !authorized()
      ? 'Conversation unavailable.'
      : current.blocked
        ? 'Correction recovery is unavailable. Keep your draft.'
        : current.busy
          ? 'Applying the selected correction…'
          : conflicts
            ? 'Check the original correction before steering again.'
            : !options.targets.length
              ? 'Choose an agent with an active turn to steer.'
              : undefined,
    message: authorized() && feedback?.owner === current ? feedback.message : undefined,
    outcomes: authorized()
      ? current.values.length
        ? current.values
            .filter(
              (value) => value.authScope === options.authScope && value.group === options.group,
            )
            .flatMap((value) => value.targets)
        : feedback?.owner === current
          ? feedback.outcomes
          : []
      : [],
    check: async () => {
      let accepted = true;
      for (const value of [...current.values])
        accepted = (await execute(structuredClone(value))) && accepted;
      return accepted;
    },
    steer: (text: string, images?: ImageAttachment[]) => {
      if (
        conflicts ||
        current.busy ||
        current.blocked ||
        !options.group ||
        !options.authScope ||
        !options.targets.length ||
        !authorized()
      )
        return Promise.resolve(false);
      const original = batch.parse({
        version: 1,
        group: options.group,
        authScope: options.authScope,
        requestId: createBrowserId(),
        targets: options.targets.map((target) => ({
          sessionId: target.sessionId,
          name: target.name,
          status: 'pending',
          input: {
            requestId: createBrowserId(),
            targetCommandId: target.commandId,
            text,
            ...(images?.length
              ? { images: images.map(({ data, mediaType }) => ({ data, mediaType })) }
              : {}),
          },
        })),
      });
      return execute(original);
    },
  };
}
