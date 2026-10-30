import { Router } from 'express';
import { z } from 'zod';
import type { AuthSession } from './auth.js';
import type { EventStore } from './event-store.js';
import type { SessionRegistry } from '@mitzo/harness';
import type { CodexConversationStore } from './codex-conversation-store.js';
import {
  callbackIncident as incident,
  incidentHash,
  inspectCallbackIncidentToolEvents,
  readCallbackIncidentEvidence,
} from './callback-incident-evidence.js';
import { reserveRepositoryStartup } from './ordinary-repository-startup.js';
import { requireSameOriginJson } from './connections-router.js';

/** Explicitly enabled operator repair for one reviewed historical callback race.
 * Runs inside the actual server/startup owner. No recovery pump/provider API. */
export function createCallbackIncidentRepairRouter(deps: {
  enabled(): boolean;
  originalSourceRoot(): string;
  events: EventStore;
  native: () => CodexConversationStore;
  registry: Pick<SessionRegistry, 'findBySessionId'>;
  authorize(id: string, auth?: AuthSession): void;
}) {
  const router = Router();
  for (const action of ['inspect', 'apply'] as const)
    router.post(`/:id/codex-callback-repair/${action}`, requireSameOriginJson, (req, res) => {
      if (!deps.enabled() || req.params.id !== incident.sessionId) {
        res.status(404).json({ error: 'Incident repair unavailable' });
        return;
      }
      const input = (
        action === 'inspect'
          ? z.strictObject({})
          : z.strictObject({ planHash: z.string().regex(/^[a-f0-9]{64}$/) })
      ).safeParse(req.body);
      if (!input.success) {
        res.status(400).json({ error: 'An exact incident inspection is required.' });
        return;
      }
      const auth = res.locals.authSession as AuthSession | undefined;
      let release: (() => void) | undefined;
      let releaseHold: (() => void) | undefined;
      try {
        try {
          deps.authorize(incident.sessionId, auth);
          if (!auth) throw Error('Operator login required');
        } catch {
          res
            .status(403)
            .json({ error: 'Use the original authorized login to inspect this repair.' });
          return;
        }
        release = reserveRepositoryStartup(incident.sessionId);
        releaseHold = deps.events.reserveOrdinaryStartup([incident.sessionId]);
        const native = deps.native();
        const guard = () => {
          deps.authorize(incident.sessionId, auth);
          const meta = deps.events.getSession(incident.sessionId);
          const runtime = deps.events.getSessionRuntimeBinding(incident.sessionId);
          const binding = meta?.accountBinding;
          if (
            deps.registry.findBySessionId(incident.sessionId) ||
            !meta ||
            meta.isActive ||
            meta.isHidden ||
            meta.telosTaskId ||
            meta.goalId ||
            meta.symposiumConfig ||
            meta.symposiumRevision ||
            meta.sessionType === 'symposium' ||
            deps.events.getLatestEvent(incident.sessionId, 'adviser_task_scope') ||
            deps.events.getLatestEvent(incident.sessionId, 'ordinary_task_worker_allocation') ||
            deps.events.getLatestEvent(incident.sessionId, 'contributor_execution') ||
            deps.events.hasUncertainOrdinaryCommand(incident.sessionId) ||
            meta.ordinaryWorkspaceId !== incident.workspaceId ||
            meta.repositoryWorkspaceId ||
            runtime?.harness.implementation !== 'codex' ||
            runtime.execution.location !== 'local' ||
            runtime.execution.targetId !== 'host-mac-codex' ||
            runtime.execution.targetRevision !==
              '5dfe0f4b100dcd3a12523aeba65d8355853b1b5d7ca8fef85d7a07ba7579062f' ||
            binding?.accountId !== 'work-openai' ||
            binding.provider !== 'openai' ||
            binding.profileRevision !==
              '102a20a80da4ff7425a6c68fb023b9b55cfd8fea2b4f2f746a9d54f42eab8f24'
          )
            throw Error('Incident owner or route changed');
          const custody = native.readHostCustody(incident.sessionId, binding);
          if (!custody || native.read(incident.sessionId, binding).cwd !== meta.cwd)
            throw Error('Original physical custody unavailable');
          return { binding, custody, runtime, meta };
        };
        const { binding, custody, runtime, meta } = guard();
        const nativeHash = native.inspectCallbackIncident(binding);
        const receipts = native.callbackIncidentToolReceipts(binding);
        if (incidentHash(JSON.stringify(receipts)) !== incident.toolsHash)
          throw Error('Incident tools changed');
        const terminal = deps.events.getEventsAfter(
          incident.sessionId,
          incident.terminalSeq - 1,
          1,
        )[0];
        if (terminal?.seq !== incident.terminalSeq || terminal.type !== 'session_end')
          throw Error('Original application terminal unavailable');
        const eventHash = inspectCallbackIncidentToolEvents(
          receipts,
          deps.events.getEventsOfType(incident.sessionId, 'block_end', 1024),
          deps.events.getEventsOfType(incident.sessionId, 'tool_result', 1024),
        );
        const evidenceHash = readCallbackIncidentEvidence(custody, deps.originalSourceRoot());
        const operatorHash = incidentHash(auth.id);
        const planHash = incidentHash(
          JSON.stringify({
            nativeHash,
            eventHash,
            evidenceHash,
            operatorHash,
            runtime,
            custody,
            workspace: meta.ordinaryWorkspaceId,
            cwd: meta.cwd,
          }),
        );
        if (action === 'inspect') {
          res.json({
            planHash,
            status: 'inspection_only',
            queuedMessages: incident.queuedIds.length,
            providerCalls: 0,
          });
          return;
        }
        if (!('planHash' in input.data) || input.data.planHash !== planHash)
          throw Error('Incident changed after inspection');
        // Fresh owner fence immediately before the synchronous SQLite CAS; no
        // asynchronous admission can cross the actual repository startup lock.
        guard();
        const result = native.applyCallbackIncident(binding, nativeHash, {
          evidenceHash: incidentHash(JSON.stringify({ evidenceHash, eventHash })),
          operatorHash,
        });
        res.json({
          ...result,
          queuedMessages: incident.queuedIds.length,
          providerCalls: 0,
          dispatched: false,
        });
      } catch {
        res.status(409).json({
          error:
            'The exact historical repair could not be qualified. Original work and queued messages remain retained; nothing was dispatched.',
        });
      } finally {
        releaseHold?.();
        release?.();
      }
    });
  return router;
}
