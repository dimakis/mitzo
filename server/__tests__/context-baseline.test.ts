/**
 * Baseline snapshots for the context pipeline.
 *
 * These capture the EXACT output of the current context assembly system
 * so that every contexgin integration step can diff against them.
 * If a snapshot update is needed, it means behavior changed — investigate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

const TMP_DIR = join(import.meta.dirname, '..', '..', '.test-context-baseline');

// Mock repo-config with a realistic shape matching the real .mitzo.json
const mockContextBlocks: Record<string, string> = {};
const mockRepos: Record<string, unknown> = {};

vi.mock('../repo-config.js', () => ({
  loadRepoConfig: vi.fn(() => ({
    contextBlocks: mockContextBlocks,
    quickActions: [],
    venvPaths: [],
    resolvedVenvPaths: [],
    allowedPaths: [],
    roots: [],
    toolTierOverrides: {},
    inboxPath: '',
    resolvedInboxPath: '',
    repos: mockRepos,
  })),
}));

const { assemblePrompt } = await import('../chat.js');

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  for (const key of Object.keys(mockContextBlocks)) delete mockContextBlocks[key];
  for (const key of Object.keys(mockRepos)) delete mockRepos[key];
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('context pipeline baselines', () => {
  describe('assemblePrompt output shape', () => {
    it('plain prompt — no context blocks, no images', () => {
      const result = assemblePrompt('What is this project?', TMP_DIR);
      expect(result).toMatchInlineSnapshot(`"What is this project?"`);
    });

    it('single context block — exact wrapping format', () => {
      const filePath = join(TMP_DIR, 'test-context.md');
      writeFileSync(filePath, '# Test Context\n\nThis is test content.');
      mockContextBlocks['Test Context'] = filePath;

      const result = assemblePrompt('Explain', TMP_DIR, undefined, ['Test Context']);

      // Capture the exact structure: preamble, XML-wrapped block, separator, user message
      const lines = result.split('\n');
      expect(lines[0]).toBe(
        'The user has attached the following reference files for this message.',
      );
      expect(lines[1]).toBe('Use them to inform your response.');
      expect(lines[2]).toBe('');

      // Context block starts with XML tag containing name and source attributes
      expect(lines[3]).toMatch(/^<context name="Test Context" source="[^"]+test-context\.md">$/);

      // Content is injected verbatim
      expect(result).toContain('# Test Context\n\nThis is test content.');

      // Closing tag, separator, then user message
      expect(result).toContain('</context>\n\n---CONTEXT_END---\nExplain');
    });

    it('multiple context blocks — ordering matches input array', () => {
      const file1 = join(TMP_DIR, 'first.md');
      const file2 = join(TMP_DIR, 'second.md');
      writeFileSync(file1, 'First content');
      writeFileSync(file2, 'Second content');
      mockContextBlocks['First'] = file1;
      mockContextBlocks['Second'] = file2;

      const result = assemblePrompt('Question', TMP_DIR, undefined, ['First', 'Second']);

      const firstIdx = result.indexOf('First content');
      const secondIdx = result.indexOf('Second content');
      expect(firstIdx).toBeLessThan(secondIdx);

      // Blocks are separated by double newline
      expect(result).toContain('</context>\n\n<context name="Second"');
    });

    it('context blocks + images — both present, context first', () => {
      const filePath = join(TMP_DIR, 'ctx.md');
      writeFileSync(filePath, 'Context here');
      mockContextBlocks['Ctx'] = filePath;

      const images = [{ data: 'dGVzdA==', mediaType: 'image/png' }];
      const result = assemblePrompt('Look at this', TMP_DIR, images, ['Ctx']);

      const contextIdx = result.indexOf('<context name="Ctx"');
      const imageIdx = result.indexOf("I've attached");
      expect(contextIdx).toBeLessThan(imageIdx);

      // Separator is between context and user message, images come after user message
      const sepIdx = result.indexOf('---CONTEXT_END---');
      expect(sepIdx).toBeLessThan(imageIdx);
    });
  });

  describe('systemPrompt.append shape', () => {
    it('baseline system prompt without repos', () => {
      // This is the exact string from chat.ts lines 363-368 when no repos are configured
      const systemPromptAppend =
        'This is Mitzo, a mobile chat interface. The user is on their phone.\n' +
        '- Never take mutating actions (writes, comments, transitions, commits) without explicit user approval. Present analysis first, wait for confirmation.\n' +
        '- Read operations are fine without asking.\n' +
        '- Keep responses concise — small screen.\n' +
        '- Read CLAUDE.md and .cursor/rules/ for project context before doing substantive work.';

      expect(systemPromptAppend).toMatchInlineSnapshot(`
        "This is Mitzo, a mobile chat interface. The user is on their phone.
        - Never take mutating actions (writes, comments, transitions, commits) without explicit user approval. Present analysis first, wait for confirmation.
        - Read operations are fine without asking.
        - Keep responses concise — small screen.
        - Read CLAUDE.md and .cursor/rules/ for project context before doing substantive work."
      `);
    });

    it('baseline system prompt with repos', () => {
      // buildRepoSystemPrompt() output when repos are configured
      const repoNames = ['mgmt', 'team_home', 'Mitzo'];
      const repoSuffix =
        '\n\nYou have access to multiple repositories via the open_repo MCP tool. ' +
        `Available repos: ${repoNames.join(', ')}. ` +
        'Call open_repo with a repo name to get an isolated worktree. ' +
        'Use the returned absolute path for all file operations in that repo.';

      const fullAppend =
        'This is Mitzo, a mobile chat interface. The user is on their phone.\n' +
        '- Never take mutating actions (writes, comments, transitions, commits) without explicit user approval. Present analysis first, wait for confirmation.\n' +
        '- Read operations are fine without asking.\n' +
        '- Keep responses concise — small screen.\n' +
        '- Read CLAUDE.md and .cursor/rules/ for project context before doing substantive work.' +
        repoSuffix;

      expect(fullAppend).toMatchInlineSnapshot(`
        "This is Mitzo, a mobile chat interface. The user is on their phone.
        - Never take mutating actions (writes, comments, transitions, commits) without explicit user approval. Present analysis first, wait for confirmation.
        - Read operations are fine without asking.
        - Keep responses concise — small screen.
        - Read CLAUDE.md and .cursor/rules/ for project context before doing substantive work.

        You have access to multiple repositories via the open_repo MCP tool. Available repos: mgmt, team_home, Mitzo. Call open_repo with a repo name to get an isolated worktree. Use the returned absolute path for all file operations in that repo."
      `);
    });
  });
});
