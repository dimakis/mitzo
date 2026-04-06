import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

const TMP_DIR = join(import.meta.dirname, '..', '..', '.test-assemble-prompt');

// Mock repo-config to provide contextBlocks
const mockContextBlocks: Record<string, string> = {};

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
    repos: {},
  })),
}));

// Must import after mock setup
const { assemblePrompt } = await import('../chat.js');

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  // Clear mock context blocks
  for (const key of Object.keys(mockContextBlocks)) delete mockContextBlocks[key];
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('assemblePrompt — context blocks', () => {
  it('returns plain prompt when no context blocks provided', () => {
    const result = assemblePrompt('Hello Claude', TMP_DIR);
    expect(result).toBe('Hello Claude');
  });

  it('returns plain prompt when contextBlocks is empty array', () => {
    const result = assemblePrompt('Hello Claude', TMP_DIR, undefined, []);
    expect(result).toBe('Hello Claude');
  });

  it('injects context blocks with preamble and separator', () => {
    const filePath = join(TMP_DIR, 'workflow.md');
    writeFileSync(filePath, '# Workflow\nStep 1: Do the thing');
    mockContextBlocks['Workflow'] = filePath;

    const result = assemblePrompt('Explain this', TMP_DIR, undefined, ['Workflow']);

    expect(result).toContain('The user has attached the following reference files');
    expect(result).toContain('<context name="Workflow"');
    expect(result).toContain('# Workflow\nStep 1: Do the thing');
    expect(result).toContain('</context>');
    expect(result).toContain('---CONTEXT_END---');
    expect(result).toContain('Explain this');
    // User message must come after separator
    const sepIndex = result.indexOf('---CONTEXT_END---');
    const msgIndex = result.indexOf('Explain this');
    expect(msgIndex).toBeGreaterThan(sepIndex);
  });

  it('injects multiple context blocks', () => {
    const file1 = join(TMP_DIR, 'workflow.md');
    const file2 = join(TMP_DIR, 'org.md');
    writeFileSync(file1, 'Workflow content');
    writeFileSync(file2, 'Org content');
    mockContextBlocks['Workflow'] = file1;
    mockContextBlocks['Org'] = file2;

    const result = assemblePrompt('Question', TMP_DIR, undefined, ['Workflow', 'Org']);

    expect(result).toContain('<context name="Workflow"');
    expect(result).toContain('Workflow content');
    expect(result).toContain('<context name="Org"');
    expect(result).toContain('Org content');
  });

  it('skips unknown context block names gracefully', () => {
    const filePath = join(TMP_DIR, 'workflow.md');
    writeFileSync(filePath, 'Workflow content');
    mockContextBlocks['Workflow'] = filePath;

    const result = assemblePrompt('Question', TMP_DIR, undefined, ['Workflow', 'NonExistent']);

    expect(result).toContain('Workflow content');
    expect(result).not.toContain('NonExistent');
  });

  it('skips context blocks whose files are missing', () => {
    mockContextBlocks['Missing'] = join(TMP_DIR, 'does-not-exist.md');

    const result = assemblePrompt('Question', TMP_DIR, undefined, ['Missing']);

    // Should fall back to plain prompt since no blocks could be read
    expect(result).toBe('Question');
  });

  it('includes source path in context tag', () => {
    const filePath = join(TMP_DIR, 'workflow.md');
    writeFileSync(filePath, 'content');
    mockContextBlocks['Workflow'] = filePath;

    const result = assemblePrompt('Q', TMP_DIR, undefined, ['Workflow']);

    expect(result).toContain(`source="${filePath}"`);
  });

  it('escapes XML-unsafe characters in name and path', () => {
    const unsafeName = 'My "Block" <test>';
    const filePath = join(TMP_DIR, 'unsafe.md');
    writeFileSync(filePath, 'safe content');
    mockContextBlocks[unsafeName] = filePath;

    const result = assemblePrompt('Q', TMP_DIR, undefined, [unsafeName]);

    // Name must be escaped in the XML attribute
    expect(result).toContain('name="My &quot;Block&quot; &lt;test&gt;"');
    expect(result).not.toContain(`name="${unsafeName}"`);
    expect(result).toContain('safe content');
  });

  it('truncates files larger than 100 KB', () => {
    const filePath = join(TMP_DIR, 'large.md');
    // Create a file just over 100 KB
    const content = 'A'.repeat(100 * 1024 + 500);
    writeFileSync(filePath, content);
    mockContextBlocks['Large'] = filePath;

    const result = assemblePrompt('Q', TMP_DIR, undefined, ['Large']);

    expect(result).toContain('[… truncated at 100 KB]');
    // Should not contain the full content
    expect(result).not.toContain('A'.repeat(100 * 1024 + 500));
    // But should contain the preamble and context tags
    expect(result).toContain('<context name="Large"');
    expect(result).toContain('</context>');
  });

  it('does not truncate files under 100 KB', () => {
    const filePath = join(TMP_DIR, 'small.md');
    const content = 'B'.repeat(50 * 1024);
    writeFileSync(filePath, content);
    mockContextBlocks['Small'] = filePath;

    const result = assemblePrompt('Q', TMP_DIR, undefined, ['Small']);

    expect(result).not.toContain('[… truncated');
    expect(result).toContain(content);
  });

  it('works alongside images', () => {
    const filePath = join(TMP_DIR, 'workflow.md');
    writeFileSync(filePath, 'Workflow content');
    mockContextBlocks['Workflow'] = filePath;

    const images = [{ data: 'dGVzdA==', mediaType: 'image/png' }];
    const result = assemblePrompt('Describe', TMP_DIR, images, ['Workflow']);

    // Should have both context blocks and image references
    expect(result).toContain('<context name="Workflow"');
    expect(result).toContain('---CONTEXT_END---');
    expect(result).toContain("I've attached 1 image(s)");
  });
});
