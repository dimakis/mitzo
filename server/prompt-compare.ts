/**
 * Prompt comparison engine: captures Mitzo's handcrafted system prompt
 * alongside ContexGin's compiled boot payload for side-by-side analysis.
 *
 * Runs at chat start (fire-and-forget). Writes comparison files to
 * the experiments spoke in mgmt.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, relative, basename } from 'path';
import { compileWithAdapters, discoverSources } from 'contexgin';
import type { CompiledContext } from 'contexgin';
import { createLogger } from './logger.js';

const log = createLogger('prompt-compare');

// ── Types ──────────────────────────────────────────────────────

export interface ProvenanceSection {
  origin: string;
  label: string;
  content: string;
  tokens: number;
  /** ContexGin-specific metadata */
  type?: string;
  tier?: string;
  headingPath?: string[];
}

export interface RepoComparison {
  repo: string;
  path: string;
  mitzo: {
    totalTokens: number;
    sections: ProvenanceSection[];
  };
  contexgin: {
    totalTokens: number;
    sections: ProvenanceSection[];
    trimmedCount: number;
  };
  diff: {
    onlyMitzo: string[];
    onlyContexgin: string[];
    shared: string[];
  };
}

export interface ComparisonReport {
  sessionId: string;
  timestamp: string;
  primaryRepo: string;
  repos: RepoComparison[];
  systemPromptAppend: string;
  systemPromptAppendTokens: number;
}

// ── Token estimation (matches ContexGin's heuristic) ──────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Mitzo effective prompt capture ─────────────────────────────

/**
 * Read the context sources that Claude Code auto-injects for a workspace.
 * This mirrors what the SDK reads: CLAUDE.md, .cursor/rules/, CONSTITUTION.md,
 * memory/Profile/*.md, SERVICES.md.
 */
export function captureMitzoEffective(workspaceRoot: string): ProvenanceSection[] {
  const sections: ProvenanceSection[] = [];

  const singleFiles = [
    { file: 'CLAUDE.md', label: 'CLAUDE.md' },
    { file: 'CONSTITUTION.md', label: 'CONSTITUTION.md' },
    { file: 'SERVICES.md', label: 'SERVICES.md' },
  ];

  for (const { file, label } of singleFiles) {
    const fullPath = join(workspaceRoot, file);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf-8');
      sections.push({
        origin: file,
        label,
        content,
        tokens: estimateTokens(content),
      });
    }
  }

  // .cursor/rules/*.mdc
  const cursorDir = join(workspaceRoot, '.cursor', 'rules');
  if (existsSync(cursorDir)) {
    try {
      const files = readdirSync(cursorDir).filter((f) => f.endsWith('.mdc'));
      for (const file of files) {
        const fullPath = join(cursorDir, file);
        const content = readFileSync(fullPath, 'utf-8');
        sections.push({
          origin: `.cursor/rules/${file}`,
          label: `Cursor rule: ${file}`,
          content,
          tokens: estimateTokens(content),
        });
      }
    } catch {
      // Directory exists but can't be read — skip
    }
  }

  // memory/Profile/*.md
  const profileDir = join(workspaceRoot, 'memory', 'Profile');
  if (existsSync(profileDir)) {
    try {
      const files = readdirSync(profileDir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const fullPath = join(profileDir, file);
        const content = readFileSync(fullPath, 'utf-8');
        sections.push({
          origin: `memory/Profile/${file}`,
          label: `Profile: ${file.replace('.md', '')}`,
          content,
          tokens: estimateTokens(content),
        });
      }
    } catch {
      // skip
    }
  }

  return sections;
}

// ── ContexGin compilation ──────────────────────────────────────

async function captureContexgin(
  workspaceRoot: string,
  budget: number = 8000,
): Promise<{ sections: ProvenanceSection[]; totalTokens: number; trimmedCount: number }> {
  const compiled: CompiledContext = await compileWithAdapters({
    workspaceRoot,
    tokenBudget: budget,
  });

  const sections: ProvenanceSection[] = [];

  if (compiled.nodes) {
    for (const node of compiled.nodes) {
      sections.push({
        origin: node.origin.relativePath,
        label: node.origin.headingPath
          ? `${node.origin.relativePath}#${node.origin.headingPath.join(' > ')}`
          : node.origin.relativePath,
        content: node.content,
        tokens: node.tokenEstimate,
        type: node.type,
        tier: node.tier,
        headingPath: node.origin.headingPath,
      });
    }
  }

  return {
    sections,
    totalTokens: compiled.bootTokens,
    trimmedCount: compiled.trimmedNodes?.length ?? compiled.trimmed?.length ?? 0,
  };
}

// ── Diff computation ───────────────────────────────────────────

function computeDiff(
  mitzoSections: ProvenanceSection[],
  contexginSections: ProvenanceSection[],
): { onlyMitzo: string[]; onlyContexgin: string[]; shared: string[] } {
  // Normalize origins for comparison (strip heading paths for file-level matching)
  const mitzoFiles = new Set(mitzoSections.map((s) => s.origin.split('#')[0]));
  const cxFiles = new Set(contexginSections.map((s) => s.origin.split('#')[0]));

  const onlyMitzo: string[] = [];
  const onlyContexgin: string[] = [];
  const shared: string[] = [];

  for (const file of mitzoFiles) {
    if (cxFiles.has(file)) {
      shared.push(file);
    } else {
      // Find the label for richer output
      const sec = mitzoSections.find((s) => s.origin.split('#')[0] === file);
      onlyMitzo.push(sec?.label ?? file);
    }
  }

  for (const file of cxFiles) {
    if (!mitzoFiles.has(file)) {
      const sec = contexginSections.find((s) => s.origin.split('#')[0] === file);
      onlyContexgin.push(sec?.label ?? file);
    }
  }

  return { onlyMitzo, onlyContexgin, shared };
}

// ── Per-repo comparison ────────────────────────────────────────

async function compareRepo(repoPath: string, repoName: string): Promise<RepoComparison> {
  // Mitzo side: read the files Claude Code would auto-inject
  const mitzoSections = captureMitzoEffective(repoPath);
  const mitzoTokens = mitzoSections.reduce((sum, s) => sum + s.tokens, 0);

  // ContexGin side: compile with adapters
  const cx = await captureContexgin(repoPath);

  // Diff
  const diff = computeDiff(mitzoSections, cx.sections);

  return {
    repo: repoName,
    path: repoPath,
    mitzo: { totalTokens: mitzoTokens, sections: mitzoSections },
    contexgin: { totalTokens: cx.totalTokens, sections: cx.sections, trimmedCount: cx.trimmedCount },
    diff,
  };
}

// ── Main entry point ───────────────────────────────────────────

/**
 * Run prompt comparison for all session repos.
 * Fire-and-forget — errors are logged, never thrown.
 *
 * @param sessionId - The session/worktree ID
 * @param primaryCwd - The primary repo working directory
 * @param systemPromptAppend - The Mitzo-specific append string
 * @param repoWorktrees - Map of repo name → { path, wtId }
 * @param outputRoot - Where to write comparison files (defaults to experiments spoke in primaryCwd)
 */
export async function capturePromptComparison(
  sessionId: string,
  primaryCwd: string,
  systemPromptAppend: string,
  repoWorktrees: Map<string, { path: string; wtId: string }>,
  outputRoot?: string,
): Promise<void> {
  try {
    const timestamp = new Date().toISOString();
    const repos: RepoComparison[] = [];

    // Always compare the primary repo
    try {
      repos.push(await compareRepo(primaryCwd, 'primary'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('comparison failed for primary repo', { error: msg });
    }

    // Compare each secondary repo
    for (const [name, { path: wtPath }] of repoWorktrees) {
      if (name === 'primary') continue;
      try {
        repos.push(await compareRepo(wtPath, name));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`comparison failed for ${name}`, { error: msg });
      }
    }

    const report: ComparisonReport = {
      sessionId,
      timestamp,
      primaryRepo: primaryCwd,
      repos,
      systemPromptAppend,
      systemPromptAppendTokens: estimateTokens(systemPromptAppend),
    };

    // Write to experiments spoke
    const outDir = outputRoot ?? join(primaryCwd, 'experiments', 'prompt-comparisons');
    mkdirSync(outDir, { recursive: true });

    const safeTimestamp = timestamp.replace(/[:.]/g, '-');
    const filename = `${sessionId}_${safeTimestamp}.json`;
    writeFileSync(join(outDir, filename), JSON.stringify(report, null, 2));

    // Log summary
    const totalMitzo = repos.reduce((s, r) => s + r.mitzo.totalTokens, 0);
    const totalCx = repos.reduce((s, r) => s + r.contexgin.totalTokens, 0);
    log.info('prompt comparison captured', {
      sessionId,
      repos: repos.length,
      mitzoTokens: totalMitzo,
      contexginTokens: totalCx,
      file: filename,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('prompt comparison failed', { error: msg });
    // Never throw — this is fire-and-forget
  }
}
