import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock contexgin before importing the module under test
vi.mock('contexgin', () => ({
  compile: vi.fn(),
}));

const { compile } = await import('contexgin');
const mockCompile = vi.mocked(compile);

const { captureMitzoEffective, capturePromptComparison } = await import('../prompt-compare.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'prompt-compare-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('captureMitzoEffective', () => {
  it('captures CLAUDE.md when present', () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# Test\nSome instructions.');
    const sections = captureMitzoEffective(tmpDir);

    expect(sections).toHaveLength(1);
    expect(sections[0].origin).toBe('CLAUDE.md');
    expect(sections[0].label).toBe('CLAUDE.md');
    expect(sections[0].content).toBe('# Test\nSome instructions.');
    expect(sections[0].tokens).toBeGreaterThan(0);
  });

  it('captures CONSTITUTION.md and SERVICES.md', () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), 'claude');
    writeFileSync(join(tmpDir, 'CONSTITUTION.md'), 'constitution');
    writeFileSync(join(tmpDir, 'SERVICES.md'), 'services');

    const sections = captureMitzoEffective(tmpDir);
    const origins = sections.map((s) => s.origin);
    expect(origins).toContain('CLAUDE.md');
    expect(origins).toContain('CONSTITUTION.md');
    expect(origins).toContain('SERVICES.md');
  });

  it('captures .cursor/rules/*.mdc files', () => {
    const rulesDir = join(tmpDir, '.cursor', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'my-rule.mdc'), 'rule content');
    writeFileSync(join(rulesDir, 'another.mdc'), 'another rule');
    writeFileSync(join(rulesDir, 'not-a-rule.txt'), 'ignored');

    const sections = captureMitzoEffective(tmpDir);
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.origin)).toContain('.cursor/rules/my-rule.mdc');
    expect(sections.map((s) => s.origin)).toContain('.cursor/rules/another.mdc');
  });

  it('captures memory/Profile/*.md files', () => {
    const profileDir = join(tmpDir, 'memory', 'Profile');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'Working Style.md'), 'style content');
    writeFileSync(join(profileDir, 'Principles.md'), 'principles');

    const sections = captureMitzoEffective(tmpDir);
    expect(sections).toHaveLength(2);
    const labels = sections.map((s) => s.label).sort();
    expect(labels).toEqual(['Profile: Principles', 'Profile: Working Style']);
  });

  it('returns empty array for empty workspace', () => {
    const sections = captureMitzoEffective(tmpDir);
    expect(sections).toEqual([]);
  });
});

describe('capturePromptComparison', () => {
  function mockCompileResponse(
    overrides: Partial<Awaited<ReturnType<typeof compile>>> = {},
  ) {
    mockCompile.mockResolvedValue({
      bootPayload: '## Compiled\nContent here.',
      bootTokens: 150,
      sources: [{ path: '/tmp/CLAUDE.md', kind: 'reference', relativePath: 'CLAUDE.md' }],
      trimmed: [],
      contextBlocks: new Map(),
      navigationHints: [],
      ...overrides,
    } as Awaited<ReturnType<typeof compile>>);
  }

  it('writes comparison file to output directory', async () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# Instructions\nDo stuff.');
    mockCompileResponse();

    const outDir = join(tmpDir, 'output');
    const repoWorktrees = new Map<string, { path: string; wtId: string }>();

    await capturePromptComparison(
      'test-session-123',
      tmpDir,
      'This is Mitzo, a mobile chat interface.',
      repoWorktrees,
      outDir,
    );

    expect(existsSync(outDir)).toBe(true);
    const files = readdirSync(outDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^test-session-123_/);
    expect(files[0]).toMatch(/\.json$/);

    const report = JSON.parse(readFileSync(join(outDir, files[0]), 'utf-8'));
    expect(report.sessionId).toBe('test-session-123');
    expect(report.primaryRepo).toBe(tmpDir);
    expect(report.systemPromptAppend).toBe('This is Mitzo, a mobile chat interface.');
    expect(report.repos).toHaveLength(1);
    expect(report.repos[0].repo).toBe('primary');
  });

  it('includes secondary repos in comparison', async () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), 'primary');
    const secondary = mkdtempSync(join(tmpdir(), 'secondary-'));
    writeFileSync(join(secondary, 'CLAUDE.md'), 'secondary');

    mockCompileResponse({ sources: [] });

    const outDir = join(tmpDir, 'output');
    const repoWorktrees = new Map([
      ['primary', { path: tmpDir, wtId: 'test' }],
      ['centaur', { path: secondary, wtId: 'test' }],
    ]);

    await capturePromptComparison('multi-repo', tmpDir, 'append', repoWorktrees, outDir);

    const files = readdirSync(outDir);
    const report = JSON.parse(readFileSync(join(outDir, files[0]), 'utf-8'));
    expect(report.repos).toHaveLength(2);
    expect(report.repos.map((r: { repo: string }) => r.repo)).toEqual(['primary', 'centaur']);

    rmSync(secondary, { recursive: true, force: true });
  });

  it('includes diff showing provenance differences', async () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), 'instructions');
    const profileDir = join(tmpDir, 'memory', 'Profile');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'Style.md'), 'style');

    // ContexGin finds CLAUDE.md and CONSTITUTION.md as sources
    mockCompile.mockResolvedValue({
      bootPayload: 'compiled',
      bootTokens: 200,
      sources: [
        { path: '', kind: 'reference', relativePath: 'CLAUDE.md' },
        { path: '', kind: 'constitution', relativePath: 'CONSTITUTION.md' },
      ],
      trimmed: [],
      contextBlocks: new Map(),
      navigationHints: [],
    } as Awaited<ReturnType<typeof compile>>);

    const outDir = join(tmpDir, 'output');
    await capturePromptComparison('diff-test', tmpDir, 'append', new Map(), outDir);

    const files = readdirSync(outDir);
    const report = JSON.parse(readFileSync(join(outDir, files[0]), 'utf-8'));

    const diff = report.repos[0].diff;
    expect(diff.shared).toContain('CLAUDE.md');
    expect(diff.onlyMitzo).toEqual(expect.arrayContaining([expect.stringContaining('Style')]));
    expect(diff.onlyContexgin).toEqual(
      expect.arrayContaining([expect.stringContaining('CONSTITUTION.md')]),
    );
  });

  it('survives ContexGin failure gracefully', async () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), 'instructions');
    mockCompile.mockRejectedValue(new Error('ContexGin is down'));

    const outDir = join(tmpDir, 'output');
    await capturePromptComparison('fail-test', tmpDir, 'append', new Map(), outDir);

    const files = readdirSync(outDir);
    expect(files).toHaveLength(1);

    const report = JSON.parse(readFileSync(join(outDir, files[0]), 'utf-8'));
    expect(report.sessionId).toBe('fail-test');
  });

  it('captures token counts for the system prompt append', async () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), 'x');
    mockCompileResponse({ bootPayload: 'x', bootTokens: 10, sources: [] });

    const append = 'This is Mitzo.\n- Keep responses concise.';
    const outDir = join(tmpDir, 'output');
    await capturePromptComparison('tokens-test', tmpDir, append, new Map(), outDir);

    const files = readdirSync(outDir);
    const report = JSON.parse(readFileSync(join(outDir, files[0]), 'utf-8'));
    expect(report.systemPromptAppend).toBe(append);
    expect(report.systemPromptAppendTokens).toBe(Math.ceil(append.length / 4));
  });

  it('contexgin sections include boot payload and source list', async () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), 'instructions');

    mockCompile.mockResolvedValue({
      bootPayload: '## Governance\nRules here.',
      bootTokens: 250,
      sources: [
        { path: '', kind: 'reference', relativePath: 'CLAUDE.md' },
        { path: '', kind: 'constitution', relativePath: 'CONSTITUTION.md' },
      ],
      trimmed: [],
      contextBlocks: new Map(),
      navigationHints: [],
    } as Awaited<ReturnType<typeof compile>>);

    const outDir = join(tmpDir, 'output');
    await capturePromptComparison('payload-test', tmpDir, 'append', new Map(), outDir);

    const files = readdirSync(outDir);
    const report = JSON.parse(readFileSync(join(outDir, files[0]), 'utf-8'));

    const cxSections = report.repos[0].contexgin.sections;
    // First section is the full boot payload
    expect(cxSections[0].origin).toBe('contexgin:bootPayload');
    expect(cxSections[0].content).toBe('## Governance\nRules here.');
    expect(cxSections[0].tokens).toBe(250);
    // Remaining sections are source pointers
    expect(cxSections[1].origin).toBe('CLAUDE.md');
    expect(cxSections[2].origin).toBe('CONSTITUTION.md');
  });
});
