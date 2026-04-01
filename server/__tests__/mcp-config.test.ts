import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadFromFile, getMcpConfigPaths } from '../mcp-config.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), `mitzo-mcp-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeConfig(filename: string, content: object): string {
  const path = join(TEST_DIR, filename);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe('loadFromFile', () => {
  it('loads stdio servers from a Cursor-format mcp.json', () => {
    const path = writeConfig('mcp.json', {
      mcpServers: {
        atlassian: {
          command: '/usr/local/bin/uvx',
          args: ['mcp-atlassian', '--jira-url', 'https://example.atlassian.net'],
        },
      },
    });

    const servers = loadFromFile(path);
    expect(Object.keys(servers)).toEqual(['atlassian']);
    expect(servers.atlassian.command).toBe('/usr/local/bin/uvx');
    expect(servers.atlassian.args).toEqual([
      'mcp-atlassian',
      '--jira-url',
      'https://example.atlassian.net',
    ]);
  });

  it('excludes disabled servers', () => {
    const path = writeConfig('mcp.json', {
      mcpServers: {
        active: { command: 'node', args: ['server.js'] },
        disabled: { command: 'node', args: ['other.js'], disabled: true },
      },
    });

    const servers = loadFromFile(path);
    expect(Object.keys(servers)).toEqual(['active']);
  });

  it('excludes servers without a command', () => {
    const path = writeConfig('mcp.json', {
      mcpServers: {
        noCommand: { args: ['something'] },
      },
    });

    const servers = loadFromFile(path as string);
    expect(Object.keys(servers)).toEqual([]);
  });

  it('excludes non-stdio server types', () => {
    const path = writeConfig('mcp.json', {
      mcpServers: {
        httpServer: { type: 'http', url: 'http://localhost:8080' },
        stdioServer: { command: 'node', args: ['server.js'] },
      },
    });

    const servers = loadFromFile(path);
    expect(Object.keys(servers)).toEqual(['stdioServer']);
  });

  it('loads multiple servers', () => {
    const path = writeConfig('mcp.json', {
      mcpServers: {
        jira: { command: 'uvx', args: ['mcp-atlassian'] },
        github: { command: 'npx', args: ['mcp-github'] },
        gitlab: { command: 'node', args: ['gitlab-mcp.js'] },
      },
    });

    const servers = loadFromFile(path);
    expect(Object.keys(servers).sort()).toEqual(['github', 'gitlab', 'jira']);
  });

  it('returns empty object for missing file', () => {
    const servers = loadFromFile('/nonexistent/path/mcp.json');
    expect(servers).toEqual({});
  });

  it('returns empty object for malformed JSON', () => {
    const path = join(TEST_DIR, 'bad.json');
    writeFileSync(path, '{ not valid json');
    const servers = loadFromFile(path);
    expect(servers).toEqual({});
  });

  it('returns empty object for file without mcpServers key', () => {
    const path = writeConfig('empty.json', { otherKey: 'value' });
    const servers = loadFromFile(path);
    expect(servers).toEqual({});
  });

  it('handles servers with command but no args', () => {
    const path = writeConfig('mcp.json', {
      mcpServers: {
        simple: { command: '/usr/bin/my-server' },
      },
    });

    const servers = loadFromFile(path);
    expect(servers.simple.command).toBe('/usr/bin/my-server');
    expect(servers.simple.args).toBeUndefined();
  });
});

describe('getMcpConfigPaths', () => {
  it('includes MCP_CONFIG_PATH when env var is set to existing file', () => {
    const path = writeConfig('custom.json', { mcpServers: {} });
    const original = process.env.MCP_CONFIG_PATH;
    process.env.MCP_CONFIG_PATH = path;

    try {
      const paths = getMcpConfigPaths();
      expect(paths).toContain(path);
    } finally {
      if (original === undefined) delete process.env.MCP_CONFIG_PATH;
      else process.env.MCP_CONFIG_PATH = original;
    }
  });

  it('does not include MCP_CONFIG_PATH when file does not exist', () => {
    const original = process.env.MCP_CONFIG_PATH;
    process.env.MCP_CONFIG_PATH = '/nonexistent/file.json';

    try {
      const paths = getMcpConfigPaths();
      expect(paths).not.toContain('/nonexistent/file.json');
    } finally {
      if (original === undefined) delete process.env.MCP_CONFIG_PATH;
      else process.env.MCP_CONFIG_PATH = original;
    }
  });
});
