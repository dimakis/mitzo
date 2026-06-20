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
import path from 'path';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import { createLogger } from './logger.js';
import { DEFAULT_AGENT_DEFINITION } from './constants.js';
import type {
  AgentDefinitionSource,
  AgentDefinition,
  AgentIdentity,
  AgentProvider,
  AgentContextConfig,
  AgentGovernance,
  AgentMemoryConfig,
  AgentOutput,
} from '@mitzo/protocol';

// Re-export from @mitzo/protocol — single source of truth
export type {
  AgentDefinitionSource,
  AgentDefinition,
  AgentIdentity,
  AgentProvider,
  AgentContextConfig,
  AgentGovernance,
  AgentMemoryConfig,
  AgentOutput,
} from '@mitzo/protocol';

const log = createLogger('agent-loader');

/** Validates agent names: lowercase alphanumeric + hyphens, no leading dash. */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

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
const FALLBACK_CACHE_TTL_MS = 30 * 1000; // 30 seconds — allow faster recovery
const cache = new Map<string, CacheEntry>();

// ─── Zod schemas for ContexGin response validation ─────────────────────────

const ContexGinIdentitySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  mode: z.enum(['narrow', 'dynamic']).optional(),
  role: z.string().optional(),
});

const ContexGinResponseSchema = z.object({
  identity: ContexGinIdentitySchema,
  provider: z
    .object({
      default: z.string(),
      tiering: z
        .object({
          fast: z.string().nullable().optional(),
          standard: z.string().nullable().optional(),
          capable: z.string().nullable().optional(),
        })
        .optional(),
    })
    .optional(),
  governance: z
    .object({
      boundaries: z
        .array(z.object({ spoke: z.string(), access: z.enum(['none', 'read', 'write']) }))
        .optional(),
      approval: z
        .object({
          required_for: z.array(z.string()).optional(),
          auto_allow: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  memory: z
    .object({
      scope: z.enum(['none', 'read', 'read-write']),
      vault: z.string().optional(),
    })
    .optional(),
  output: z
    .object({
      conventions: z
        .object({
          commit_style: z.string().optional(),
          response_format: z.string().nullable().optional(),
        })
        .optional(),
      guides: z.array(z.string()).optional(),
    })
    .optional(),
  boot: z
    .object({
      tokens: z.number().optional(),
      content: z.string().optional(),
      sources: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
});

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

    const raw = await res.json();
    const parsed = ContexGinResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn('ContexGin response failed validation', {
        agent: agentName,
        errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return null;
    }

    const { identity, provider, governance, memory, output, boot } = parsed.data;
    const context: AgentContextConfig | undefined = boot?.tokens
      ? { budget: boot.tokens }
      : undefined;

    return {
      definition: {
        identity,
        provider: provider ?? { default: 'claude-opus-4' },
        context,
        governance,
        memory,
        output,
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
    const agentsDir = path.resolve(cwd, '.agents');
    const filePath = path.resolve(agentsDir, `${agentName}.yaml`);
    const rel = path.relative(agentsDir, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

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
  // Validate agent name early — reject before any source attempt
  if (!AGENT_NAME_RE.test(agentName)) {
    log.warn('invalid agent name rejected', { agent: agentName });
    return {
      definition: DEFAULT_AGENT_DEFINITION,
      source: 'fallback',
    };
  }

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

  // 3. Bundled fallback — shorter TTL so we recover faster when ContexGin comes back
  log.info('using bundled agent definition fallback', { agent: agentName });
  const fallback: LoadedAgentDefinition = {
    definition: {
      ...DEFAULT_AGENT_DEFINITION,
      identity: { ...DEFAULT_AGENT_DEFINITION.identity, name: agentName },
    },
    source: 'fallback',
  };
  cache.set(cacheKey, { result: fallback, expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS });
  return fallback;
}
