import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { OwnedReleasePlan } from './symposium-owned-release.js';
import type { SymposiumCustodianConstructorHooks } from './symposium-custodian-main.js';
import { openStagingRegistry } from './symposium-staging-registry.js';

export const StagingLaunchSchema = z.strictObject({
  registryDirectory: z.string().refine(isAbsolute),
  capacity: z.number().int().min(1).max(20),
  ownerChat: z.string(),
  purpose: z.string(),
  retentionReason: z.string(),
  reviewAfter: z.number().int().positive(),
});
/** Same fresh launcher/host lifetime. No existing registration can be resumed. */
export async function launchStagingCustodian(
  plan: OwnedReleasePlan,
  registration: z.infer<typeof StagingLaunchSchema>,
  deps: {
    verify(plan: OwnedReleasePlan): void;
    claim(plan: OwnedReleasePlan): void;
    run(hooks: SymposiumCustodianConstructorHooks): Promise<void>;
  },
) {
  const input = StagingLaunchSchema.parse(registration);
  deps.verify(plan);
  const registry = openStagingRegistry(input.registryDirectory, input.capacity);
  let owner: ReturnType<typeof registry.reserve> | undefined;
  let terminal = false;
  try {
    owner = registry.reserve({
      ownerChat: input.ownerChat,
      purpose: input.purpose,
      retentionReason: input.retentionReason,
      reviewAfter: input.reviewAfter,
      planDirectory: plan.planDirectory,
      sourceCommit: plan.sourceCommit,
      buildSha256: plan.buildSha256,
      configSha256: plan.configSha256,
    });
    const original = owner;
    deps.claim(plan);
    deps.verify(plan);
    await deps.run({
      observeController(identity, current) {
        current();
        original.controller(identity);
        current();
      },
      observeRetirement(state, stateParent) {
        if (state === 'retiring') original.retiring();
        else if (state === 'uncertain') original.uncertain();
        else {
          original.retired(stateParent);
          terminal = true;
        }
      },
    });
    if (!terminal) throw Error('Staging retirement remains uncertain');
  } catch (error) {
    if (owner && !terminal) {
      try {
        owner.uncertain();
      } catch {
        /* Interrupted reservation stays held. */
      }
    }
    throw error;
  } finally {
    registry.close();
  }
}
