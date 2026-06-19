/**
 * Agent definition loader — discover, load, and cache agent recipes.
 *
 * Resolution order:
 * 1. ContexGin API — GET /api/agents/:name/context (preferred)
 * 2. Local override — .agents/{name}.yaml in workspace root (dev/testing)
 * 3. Bundled fallback — DEFAULT_AGENT_DEFINITION from constants
 *
 * Never blocks session start. All failures are graceful.
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { load as parseYaml } from 'js-yaml';
import { createLogger } from './logger.js';
import { DEFAULT_AGENT_DEFINITION } from './constants.js';

const log = createLogger('agent-loader');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentIdentity {
  name: string;
  description: string;
  mode?: 'narrow' | 'dynamic';
  role?: string;
}

export interface AgentProviderTiering {
  fast?: string | null;
  standard?: string | null;
  capable?: string | null;
}

export interface AgentProvider {
  default: string;
  tiering?: AgentProviderTiering;
}

export interface AgentContextConfig {
  budget?: number;
  sources?: {
    hubs?: Array<{ path: string; spokes?: string[] }>;
  };
  priority?: string[];
  exclude?: string[];
  profile?: string;
}

export interface GovernanceBoundary {
  spoke: string;
  access: 'none' | 'read' | 'write';
}

export interface GovernanceApproval {
  required_for?: string[];
  auto_allow?: string[];
}

export interface AgentGovernance {
  boundaries?: GovernanceBoundary[];
  approval?: GovernanceApproval;
}

export interface AgentMemoryConfig {
  scope: 'none' | 'read' | 'read-write';
  vault?: string;
}

export interface AgentOutputConventions {
  commit_style?: string;
  response_format?: string | null;
}

export interface AgentOutput {
  conventions?: AgentOutputConventions;
  guides?: string[];
}

export interface AgentDefinition {
  identity: AgentIdentity;
  provider: AgentProvider;
  context?: AgentContextConfig;
  governance?: AgentGovernance;
  memory?: AgentMemoryConfig;
  output?: AgentOutput;
}

// Re-export from harness to avoid duplicate definition
export type { AgentDefinitionSource } from '@mitzo/harness';

export interface LoadedAgentDefinition {
  definition: AgentDefinition;
  source: AgentDefinitionSource;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: LoadedAgentDefinition;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry>();

/** Clear the agent definition cache (for testing). */
export function clearCache(): void {
  cache.clear();
}

// ─── Loaders ────────────────────────────────────────────────────────────────

/**
 * Try to load agent definition from ContexGin API.
 * Returns null on any failure — never throws.
 */
async function loadFromContexGin(
  agentName: string,
  contexginUrl: string,
): Promise<LoadedAgentDefinition | null> {
  try {
    const url = `${contexginUrl}/api/agents/${encodeURIComponent(agentName)}/context`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, unknown>;

    // ContexGin returns identity, provider, governance, memory at the top level
    const identity = data.identity as AgentIdentity | undefined;
    if (!identity?.name || !identity?.description) return null;

    const provider = data.provider as AgentProvider | undefined;
    const governance = data.governance as AgentGovernance | undefined;
    const memory = data.memory as AgentMemoryConfig | undefined;

    // Extract context config from boot response
    const boot = data.boot as Record<string, unknown> | undefined;
    const context: AgentContextConfig | undefined = boot
      ? { budget: typeof boot.tokens === 'number' ? boot.tokens : undefined }
      : undefined;

    return {
      definition: {
        identity,
        provider: provider ?? { default: 'claude-opus-4' },
        context,
        governance,
        memory,
      },
      source: 'contexgin',
    };
  } catch {
    return null;
  }
}

/**
 * Try to load agent definition from a local .agents/{name}.yaml file.
 * Returns null if file doesn't exist or is malformed.
 */
async function loadFromLocal(
  agentName: string,
  cwd: string,
): Promise<LoadedAgentDefinition | null> {
  try {
    // Validate agent name to prevent path traversal
    if (!/^[a-z0-9][a-z0-9-]*$/.test(agentName)) return null;

    const agentsDir = resolve(cwd, '.agents');
    const filePath = resolve(agentsDir, `${agentName}.yaml`);
    if (!filePath.startsWith(agentsDir + '/')) return null;

    const raw = await readFile(filePath, 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;

    if (!parsed || typeof parsed !== 'object') return null;

    const identity = parsed.identity as AgentIdentity | undefined;
    if (!identity?.name || !identity?.description) return null;

    // Map the Centaur schema to our internal types
    const provider = parsed.provider as AgentProvider | undefined;
    const context = parsed.context as AgentContextConfig | undefined;
    const governance = parsed.governance as AgentGovernance | undefined;
    const memory = parsed.memory as AgentMemoryConfig | undefined;
    const output = parsed.output as AgentOutput | undefined;

    return {
      definition: {
        identity,
        provider: provider ?? { default: 'claude-opus-4' },
        context,
        governance,
        memory,
        output,
      },
      source: 'local',
    };
  } catch {
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load an agent definition, trying ContexGin → local override → bundled fallback.
 * Results are cached for 5 minutes. Never throws.
 */
export async function loadAgentDef(
  agentName: string,
  cwd: string,
  contexginUrl: string = process.env.CONTEXGIN_URL || 'http://localhost:8321',
): Promise<LoadedAgentDefinition> {
  // Check cache
  const cacheKey = `${agentName}:${cwd}:${contexginUrl}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  // 1. Try ContexGin
  const fromContexGin = await loadFromContexGin(agentName, contexginUrl);
  if (fromContexGin) {
    log.info('agent definition loaded from ContexGin', {
      agent: agentName,
      identity: fromContexGin.definition.identity.description,
    });
    cache.set(cacheKey, { result: fromContexGin, expiresAt: Date.now() + CACHE_TTL_MS });
    return fromContexGin;
  }

  // 2. Try local override
  const fromLocal = await loadFromLocal(agentName, cwd);
  if (fromLocal) {
    log.info('agent definition loaded from local .agents/', {
      agent: agentName,
      identity: fromLocal.definition.identity.description,
    });
    cache.set(cacheKey, { result: fromLocal, expiresAt: Date.now() + CACHE_TTL_MS });
    return fromLocal;
  }

  // 3. Bundled fallback
  log.info('using bundled agent definition fallback', { agent: agentName });
  const fallback: LoadedAgentDefinition = {
    definition: {
      ...DEFAULT_AGENT_DEFINITION,
      identity: { ...DEFAULT_AGENT_DEFINITION.identity, name: agentName },
    },
    source: 'fallback',
  };
  cache.set(cacheKey, { result: fallback, expiresAt: Date.now() + CACHE_TTL_MS });
  return fallback;
}
