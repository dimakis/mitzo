import { z } from 'zod';
import {
  OrdinaryLocalCommandAdmissionSchema,
  OrdinaryLocalCommandSelectionSchema,
} from './ordinary-local-admission.js';
import { SessionRuntimeBindingV2Schema } from './session-runtime-binding.js';
export const OrdinaryLocalVertexCommandAdmissionSchema = z.strictObject({
  ...OrdinaryLocalCommandAdmissionSchema.omit({
    preparedRepositoryTransition: true,
    preparedRepositoryPrimaryCommandId: true,
  }).shape,
  binding: SessionRuntimeBindingV2Schema.refine(
    (binding) =>
      binding.execution.location === 'local' &&
      binding.account.provider === 'anthropic-vertex' &&
      binding.harness.implementation === 'claude-sdk',
    'Ordinary Local Vertex Claude route required',
  ),
  selection: OrdinaryLocalCommandSelectionSchema,
});
export type OrdinaryLocalVertexCommandAdmission = z.infer<
  typeof OrdinaryLocalVertexCommandAdmissionSchema
>;
