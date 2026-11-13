import { Router, type Request } from 'express';
import { z } from 'zod';
import { checkSkillPolicy, type SessionRegistry } from '@mitzo/harness';
import { TelosCreateSessionInputSchema } from '@mitzo/protocol';
import type { SessionLaunchController } from './session-launch-controller.js';
import { proposeTelosSession } from './session-launch-tools.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { sessionToolOperatorConnection } from './native-host-tool-operator.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import { SessionLaunchError } from './session-launch-store.js';
import { createLogger } from './logger.js';
import { retainTelosSessionProposalFailure } from './telos-session-proposal-failure.js';
export { executeTelosCreateSession } from './telos-session-launch-tool.js';
export { telosSessionProposalFailure } from './telos-session-proposal-failure.js';

const log = createLogger('telos-session-proposal');
const envelope = z.strictObject({
  clientId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  input: TelosCreateSessionInputSchema,
});

/** Claude's host MCP transport creates only a review proposal. The verified
 * current SDK owner and authenticated operator are derived outside model JSON. */
export function createTelosSessionProposalRouter(deps: {
  controller: SessionLaunchController;
  registry: SessionRegistry;
  verifyInternal(req: Request): boolean;
  ordinaryConversation(id: string): boolean;
}) {
  const router = Router();
  router.post('/api/internal/telos/session/propose', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!deps.verifyInternal(req)) {
      res
        .status(401)
        .json({ code: 'unauthorized', error: 'Internal host authentication required.' });
      return;
    }
    const parsed = envelope.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'invalid', error: 'Exact work/session proposal input required.' });
      return;
    }
    const { clientId, sessionId, input } = parsed.data;
    const session = deps.registry.get(clientId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', close);
    const timer = setTimeout(abort, 120000);
    try {
      const current = () => {
        controller.signal.throwIfAborted();
        if (
          !session ||
          session.abortController.signal.aborted ||
          !deps.verifyInternal(req) ||
          req.headers['x-client-id'] !== clientId ||
          deps.registry.get(clientId) !== session ||
          session.sessionId !== sessionId ||
          !deps.ordinaryConversation(sessionId) ||
          deps.registry.isClosingOut(clientId) ||
          deps.registry.isUserClose(clientId) ||
          !agentToolAllowed(session, 'TelosCreateSession') ||
          checkSkillPolicy(deps.registry, clientId, 'mcp__telos__TelosCreateSession') === 'deny'
        )
          throw new SessionLaunchError(
            'The exact current ordinary caller and selected Telos tool are required.',
            403,
          );
      };
      current();
      const connectionId = sessionToolOperatorConnection(session!, clientId);
      const captured = captureAgentLibraryAuthorization(connectionId);
      const signal = AbortSignal.any([controller.signal, session!.abortController.signal]);
      const result = await proposeTelosSession(deps.controller, sessionId, input, {
        operatorConnectionId: connectionId,
        authSessionId: captured.auth.id,
        signal,
        assertCurrent() {
          current();
          captured.assertCurrent();
          if (sessionToolOperatorConnection(session!, clientId) !== connectionId)
            throw new SessionLaunchError('The originating operator changed.', 403);
        },
      });
      current();
      captured.assertCurrent();
      res.json(result);
    } catch (cause) {
      const known = cause instanceof SessionLaunchError;
      if (!known) {
        retainTelosSessionProposalFailure(input.requestId, 'proposal', cause);
        log.error('Telos session proposal unavailable', {
          stage: 'proposal',
          code: 'telos_session_proposal_failed',
          requestId: input.requestId,
          sourceSessionId: sessionId,
        });
      }
      // Losing the HTTP consumer prevents delivery, but must not discard the
      // original failure or its sanitized operation diagnostic.
      if (res.destroyed) return;
      res.status(known ? cause.status : 503).json({
        stage: 'proposal',
        code: known ? 'telos_session_proposal_refused' : 'telos_session_proposal_failed',
        requestId: input.requestId,
        error: known
          ? cause.message
          : 'The work-bound proposal is unconfirmed. Inspect or retry this original request; do not substitute StartSession.',
      });
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
      res.off('close', close);
    }
  });
  return router;
}
