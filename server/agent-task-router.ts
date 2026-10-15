import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import {
  AgentTaskIdSchema,
  CreateAgentTaskSchema,
  UpdateAgentTaskSchema,
  RemoveAgentTaskSchema,
} from '@mitzo/protocol';
import { AgentTaskError } from './agent-task-store.js';
import type { AgentTaskService } from './agent-task-service.js';
import { requireSameOriginJson } from './connections-router.js';
import { registerAuthSession, type AuthSession } from './auth.js';
import { custodianRequestAuthority } from './symposium-custodian-authority.js';

const OWNER = 'user'; // Same stable single-operator subject as Agent Library, never the login JTI.
function failure(res: Response, error: unknown) {
  const status =
    error instanceof AgentTaskError ? error.status : error instanceof ZodError ? 400 : 500;
  res.status(status).json({
    error:
      status === 500
        ? 'Task persistence unavailable'
        : error instanceof Error
          ? error.message
          : 'Invalid task request',
  });
}
export function createAgentTaskRouter(service: AgentTaskService): Router {
  const router = Router();
  router.use((req, res, next) => {
    const auth = res.locals.authSession as AuthSession | undefined;
    if (!auth || auth.expiresAt <= Date.now())
      return res.status(403).json({ error: 'Interactive operator authentication is required' });
    let revoked = false;
    const unregister = registerAuthSession(auth, () => {
      revoked = true;
    });
    res.once('finish', unregister);
    res.once('close', unregister);
    res.locals.assertTaskAuthority = () => {
      try {
        custodianRequestAuthority(req); // Recheck original owner epoch/revocation at dispatch.
      } catch {
        throw new AgentTaskError('Task authorization expired or revoked', 403);
      }
      if (revoked || auth.expiresAt <= Date.now())
        throw new AgentTaskError('Task authorization expired or revoked', 403);
    };
    next();
  });
  const act = (res: Response, work: () => unknown) => {
    try {
      res.locals.assertTaskAuthority();
      res.json(work());
    } catch (error) {
      failure(res, error);
    }
  };
  router.get('/', (_req, res) => act(res, () => service.list(OWNER)));
  router.get('/:taskId', (req, res) =>
    act(res, () => service.read(OWNER, AgentTaskIdSchema.parse(req.params.taskId))),
  );
  router.post('/', requireSameOriginJson, (req, res) =>
    act(res, () => service.save(OWNER, CreateAgentTaskSchema.parse(req.body))),
  );
  router.put('/:taskId', requireSameOriginJson, (req, res) =>
    act(res, () => {
      const body = UpdateAgentTaskSchema.omit({ taskId: true }).parse(req.body);
      return service.save(OWNER, { ...body, taskId: AgentTaskIdSchema.parse(req.params.taskId) });
    }),
  );
  router.delete('/:taskId', requireSameOriginJson, (req, res) =>
    act(res, () => {
      const body = RemoveAgentTaskSchema.omit({ taskId: true }).parse(req.body);
      return service.remove(OWNER, { ...body, taskId: AgentTaskIdSchema.parse(req.params.taskId) });
    }),
  );
  return router;
}
