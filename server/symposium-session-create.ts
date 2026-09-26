import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { AccountProfiles } from './account-profiles.js';
import type { EventStore } from './event-store.js';
import type { SymposiumProfileStore } from './symposium-profiles.js';

const Request = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(160),
  accountId: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(128),
  reasoningEffort: z.string().trim().min(1).max(64).nullable().optional(),
  role: z.enum(['coder', 'reviewer']),
  profileSelection: z.strictObject({
    profileId: z.string().trim().min(1).max(128),
    revision: z.number().int().positive(),
  }),
});

/** Operator-only mounting required. No ordinary account loader or runtime launch capability. */
export function createSymposiumSessionRouter(deps: {
  store: Pick<EventStore, 'getSymposiumSessionAllocation' | 'createSymposiumSession'>;
  profiles: Pick<SymposiumProfileStore, 'get'>;
  currentAccounts(): AccountProfiles;
  newSessionId?: () => string;
}) {
  const router = Router();
  router.post('/', (req, res) => {
    const parsed = Request.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          'Choose an explicit Symposium account, model, supported role and saved profile revision.',
      });
      return;
    }
    try {
      const { idempotencyKey, ...selection } = parsed.data;
      const fingerprint = createHash('sha256').update(JSON.stringify(selection)).digest('hex');
      const key = `user:${idempotencyKey}`;
      const retry = deps.store.getSymposiumSessionAllocation(key, fingerprint);
      if (retry) {
        res.json({ sessionId: retry, created: false });
        return;
      }
      const accounts = deps.currentAccounts();
      const binding = accounts.resolve(selection.accountId, selection.model);
      accounts.validateModelSelection(binding, selection.model, selection.reasoningEffort);
      if (!['openai', 'openai-codex'].includes(binding.provider))
        throw new Error('This account provider is not available for native Symposium creation');
      const profile = deps.profiles.get(
        'user',
        selection.profileSelection.profileId,
        selection.profileSelection.revision,
      );
      if (!profile || profile.definition.role !== selection.role)
        throw new Error('Select a saved profile revision matching the supported seat role');
      const definition = profile.definition;
      const config = {
        version: 2,
        revision: 1,
        state: 'draft',
        anchorSeatId: 'primary',
        activeSeatCap: 3,
        seats: [
          {
            id: 'primary',
            name: definition.name,
            role: selection.role,
            model: binding.model,
            accountBinding: binding,
            systemPrompt: definition.instructions,
            expectedOutput: definition.expectedOutput,
            acceptanceCriteria: definition.acceptanceCriteria,
            color: '#335577',
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          },
        ],
        turnRules: { mode: 'directed', maxTurns: 8 },
        interceptMode: 'manual',
      };
      const result = deps.store.createSymposiumSession({
        idempotencyKey: key,
        fingerprint,
        sessionId: deps.newSessionId?.() ?? randomUUID(),
        summary: selection.title,
        binding,
        config,
        profileSelections: { primary: selection.profileSelection },
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      res.status(409).json({
        error: error instanceof Error ? error.message : 'Symposium draft could not be created',
      });
    }
  });
  return router;
}
