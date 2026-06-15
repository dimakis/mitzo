/**
 * Multi-model reasoning — deliberation + fusion orchestrators.
 *
 * Two complementary modes:
 * - Deliberation: sequential adversarial (propose → challenge → respond → converge)
 * - Fusion: parallel fan-out → judge analysis → synthesis
 */

export { DeliberationOrchestrator, DEFAULT_DELIBERATION_CONFIG } from './deliberation.js';
export { FusionOrchestrator, DEFAULT_FUSION_CONFIG, SELF_FUSION_CONFIG } from './fusion.js';
export type {
  // Shared
  TranscriptEntry,
  CostTracker,
  ReasoningEvent,
  ReasoningEventHandler,

  // Deliberation
  AgentRole,
  DeliberationConfig,
  DeliberationRound,
  DeliberationResult,

  // Fusion
  PanelMember,
  FusionConfig,
  JudgeAnalysis,
  FusionResult,
} from './types.js';
