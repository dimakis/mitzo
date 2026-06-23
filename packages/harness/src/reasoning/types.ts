/**
 * Shared types for multi-model reasoning modes (deliberation + fusion).
 *
 * Both modes share:
 * - Cost tracking and budget enforcement
 * - Transcript recording
 * - Event emission for streaming UI
 */

import type { TokenUsage } from '../providers/types.js';

// ─── Shared ────────────────────────────────────────────────────────────────

/** A single entry in the reasoning transcript. */
export interface TranscriptEntry {
  /** Which participant produced this (e.g. 'proposer', 'challenger', 'panel-1', 'judge'). */
  speaker: string;
  /** Model that produced the content. */
  model: string;
  /** The phase this entry belongs to. */
  phase: string;
  /** Content of the message. */
  content: string;
  /** Token usage for this call. */
  usage: TokenUsage;
  /** Cost in USD for this call. */
  costUsd: number;
  /** Timestamp. */
  timestamp: number;
}

/** Cost tracking state shared across reasoning modes. */
export interface CostTracker {
  totalCost: number;
  budgetUsd: number;
  entries: Array<{ model: string; costUsd: number; phase: string }>;
}

/** Events emitted during reasoning for streaming UI. */
export type ReasoningEvent =
  | { type: 'reasoning_start'; mode: 'deliberation' | 'fusion'; task: string }
  | { type: 'phase_start'; phase: string; speaker: string; model: string }
  | { type: 'phase_delta'; phase: string; speaker: string; delta: string }
  | { type: 'phase_end'; phase: string; speaker: string; content: string; costUsd: number }
  | { type: 'reasoning_end'; mode: 'deliberation' | 'fusion'; totalCost: number };

/** Callback for streaming reasoning events to the UI. */
export type ReasoningEventHandler = (event: ReasoningEvent) => void;

// ─── Deliberation ──────────────────────────────────────────────────────────

/** Configuration for one participant in deliberation. */
export interface AgentRole {
  /** Display name (e.g. 'architect', 'critic'). */
  name: string;
  /** Canonical model name (e.g. 'claude-opus-4-6'). */
  model: string;
  /** System prompt for this role. */
  systemPrompt: string;
  /** Temperature for this role's calls. */
  temperature?: number;
}

/** Deliberation protocol configuration. */
export interface DeliberationConfig {
  proposer: AgentRole;
  challenger: AgentRole;
  /** Number of challenge/respond cycles. */
  maxRounds: number;
  /** Convergence strategy. */
  convergence: 'fixed-rounds' | 'explicit-agreement';
  /** Cost ceiling per deliberation in USD. */
  budgetUsd: number;
  /** Event handler for streaming UI updates. */
  onEvent?: ReasoningEventHandler;
}

/** One challenge/respond cycle in a deliberation. */
export interface DeliberationRound {
  roundNum: number;
  challenge: string;
  response: string;
  positionChanged: boolean;
  changeDetail?: string;
}

/** Output of a complete deliberation run. */
export interface DeliberationResult {
  /** Final converged output. */
  final: string;
  /** Initial proposal before challenges. */
  proposal: string;
  /** All challenge/respond rounds. */
  rounds: DeliberationRound[];
  /** Number of times the proposer changed position. */
  mindChanges: number;
  /** Total cost in USD. */
  totalCost: number;
  /** Full transcript of all calls. */
  transcript: TranscriptEntry[];
}

// ─── Fusion ────────────────────────────────────────────────────────────────

/** Configuration for a fusion panel member. */
export interface PanelMember {
  /** Canonical model name. */
  model: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
}

/** Fusion orchestrator configuration. */
export interface FusionConfig {
  /** Models to fan out to in parallel. */
  panelModels: PanelMember[];
  /** Model that analyzes and compares panel responses. */
  judgeModel: {
    model: string;
    systemPrompt?: string;
  };
  /** Model that writes the final synthesized answer (defaults to judge model). */
  synthesizerModel?: {
    model: string;
    systemPrompt?: string;
  };
  /** Cost ceiling per fusion run in USD. */
  budgetUsd: number;
  /** Event handler for streaming UI updates. */
  onEvent?: ReasoningEventHandler;
}

/** Structured judge analysis comparing panel responses. */
export interface JudgeAnalysis {
  /** Points all/most panel members agree on. */
  consensus: string[];
  /** Direct disagreements between models. */
  contradictions: Array<{
    topic: string;
    positions: Array<{ model: string; position: string }>;
  }>;
  /** Topics only some models addressed. */
  partialCoverage: string[];
  /** Non-redundant contributions from individual models. */
  uniqueInsights: Array<{
    model: string;
    insight: string;
  }>;
  /** Questions or topics none of the panel addressed. */
  blindSpots: string[];
}

/** Output of a complete fusion run. */
export interface FusionResult {
  /** Final synthesized output. */
  finalOutput: string;
  /** Structured comparison from the judge. */
  judgeAnalysis: JudgeAnalysis;
  /** Raw responses from each panel member. */
  panelResponses: Array<{ model: string; response: string }>;
  /** Total cost in USD. */
  totalCost: number;
  /** Full transcript of all calls. */
  transcript: TranscriptEntry[];
}
