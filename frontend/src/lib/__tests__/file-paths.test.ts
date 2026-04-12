import { describe, it, expect } from 'vitest';
import { detectFilePaths, isFilePath, linkifyFilePaths, FILE_SCHEME } from '../file-paths';

describe('isFilePath', () => {
  it('recognises absolute Unix paths', () => {
    expect(isFilePath('/Users/dsaridak/redhat/mgmt/README.md')).toBe(true);
    expect(isFilePath('/tmp/output.json')).toBe(true);
    expect(isFilePath('/etc/nginx/nginx.conf')).toBe(true);
  });

  it('recognises relative paths with extension', () => {
    expect(isFilePath('./src/index.ts')).toBe(true);
    expect(isFilePath('src/components/App.tsx')).toBe(true);
    expect(isFilePath('../docs/guide.md')).toBe(true);
  });

  it('rejects URLs', () => {
    expect(isFilePath('https://example.com/page')).toBe(false);
    expect(isFilePath('http://localhost:3000')).toBe(false);
  });

  it('rejects plain words and sentences', () => {
    expect(isFilePath('hello')).toBe(false);
    expect(isFilePath('the quick brown fox')).toBe(false);
    expect(isFilePath('npm install')).toBe(false);
  });

  it('rejects Unix commands that look path-like', () => {
    expect(isFilePath('/bin/bash')).toBe(true); // this is a valid path
  });

  it('handles paths with spaces in quotes', () => {
    expect(isFilePath('/Users/me/my project/file.ts')).toBe(true);
  });

  it('rejects root slash alone', () => {
    expect(isFilePath('/')).toBe(false);
  });

  it('rejects paths without file-like segments', () => {
    expect(isFilePath('/just-a-slug')).toBe(false);
  });

  it('recognises extensionless paths with multiple segments', () => {
    expect(isFilePath('/Users/dsaridak/redhat/mgmt/scripts/build')).toBe(true);
  });
});

describe('detectFilePaths', () => {
  it('finds absolute paths in text', () => {
    const text =
      'I created the file at /Users/dsaridak/redhat/mgmt/architecture/design.md for you.';
    const result = detectFilePaths(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      path: '/Users/dsaridak/redhat/mgmt/architecture/design.md',
      start: 22,
      end: 72,
    });
  });

  it('finds multiple paths in text', () => {
    const text = 'See /tmp/a.md and also ./src/b.ts for details.';
    const result = detectFilePaths(text);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('/tmp/a.md');
    expect(result[1].path).toBe('./src/b.ts');
  });

  it('returns empty array for text without paths', () => {
    expect(detectFilePaths('just a normal sentence')).toEqual([]);
  });

  it('handles backtick-wrapped paths', () => {
    const text = 'The file is at `/Users/me/project/foo.ts`.';
    const result = detectFilePaths(text);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/Users/me/project/foo.ts');
  });

  it('does not match URLs', () => {
    const text = 'Visit https://example.com/path/to/page for info.';
    expect(detectFilePaths(text)).toEqual([]);
  });

  it('handles paths at end of line', () => {
    const text = 'Output written to /tmp/result.json';
    const result = detectFilePaths(text);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/tmp/result.json');
  });

  it('handles relative paths starting with dot-slash', () => {
    const text = 'Check ./architecture/decisions/001.md for context.';
    const result = detectFilePaths(text);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('./architecture/decisions/001.md');
  });
});

describe('linkifyFilePaths', () => {
  it('wraps absolute paths in markdown links', () => {
    const input = 'Created /tmp/output.md for you.';
    const result = linkifyFilePaths(input);
    expect(result).toBe(
      `Created [/tmp/output.md](${FILE_SCHEME}${encodeURIComponent('/tmp/output.md')}) for you.`,
    );
  });

  it('wraps relative paths in markdown links', () => {
    const input = 'See ./src/index.ts for details.';
    const result = linkifyFilePaths(input);
    expect(result).toContain(`[./src/index.ts](${FILE_SCHEME}`);
  });

  it('skips paths inside code blocks', () => {
    const input = '```\n/tmp/output.md\n```';
    expect(linkifyFilePaths(input)).toBe(input);
  });

  it('skips paths inside inline backticks', () => {
    const input = 'Run `cat /tmp/output.md` to see it.';
    expect(linkifyFilePaths(input)).toBe(input);
  });

  it('handles multiple paths on different lines', () => {
    const input = 'File 1: /tmp/a.md\nFile 2: /tmp/b.md';
    const result = linkifyFilePaths(input);
    expect(result).toContain(`[/tmp/a.md]`);
    expect(result).toContain(`[/tmp/b.md]`);
  });

  it('does not double-linkify already-linked paths', () => {
    const input = 'See [/tmp/a.md](/files?path=/tmp/a.md) for details.';
    const result = linkifyFilePaths(input);
    // Should not wrap the already-linked path again
    expect(result).not.toContain(`${FILE_SCHEME}`);
  });

  it('leaves text without paths unchanged', () => {
    const input = 'Just a regular sentence.';
    expect(linkifyFilePaths(input)).toBe(input);
  });
});
