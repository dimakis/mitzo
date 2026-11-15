import { TelosStartSliceInputSchema, TelosWorkControlToolInputSchema } from '@mitzo/protocol';
import { telosBacklogSchemas, telosBacklogDefinitions } from './telos-backlog-tools.js';
import { telosArtifactSchemas, telosArtifactDefinitions } from './telos-artifact-tools.js';
import { telosItemSchemas, telosItemDefinitions } from './telos-item-tools.js';
import {
  TelosOutcomeInput,
  TelosAdoptSourceInput,
  telosCreateOutcomeDefinition,
  telosAdoptSourceDefinition,
} from './telos-tool.js';
import { telosWorkDefinitions } from './telos-work-tools.js';
import { telosWorkControlDefinitions } from './telos-work-control-tools.js';

/** Wire projection of canonical Telos contracts; no independent schemas or storage. */
export const telosSdkSchemas = {
  ...telosBacklogSchemas,
  ...telosArtifactSchemas,
  ...telosItemSchemas,
  TelosCreateOutcome: TelosOutcomeInput,
  TelosAdoptSource: TelosAdoptSourceInput,
  TelosStartSlice: TelosStartSliceInputSchema,
  TelosWorkControl: TelosWorkControlToolInputSchema,
};
export const telosSdkDefinitions = [
  ...telosBacklogDefinitions,
  ...telosArtifactDefinitions,
  ...telosItemDefinitions,
  telosCreateOutcomeDefinition,
  telosAdoptSourceDefinition,
  ...telosWorkDefinitions,
  ...telosWorkControlDefinitions,
];
export const telosSdkToolNames = Object.keys(telosSdkSchemas);
export const telosSdkPrefix = 'mcp__telos__';
