import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger.js';

const log = createLogger('mcp');

interface CursorMcpEntry {
  command: string;
  args?: string[];
  disabled?: boolean;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

interface CursorMcpFile {
  mcpServers?: Record<string, CursorMcpEntry>;
}

export interface McpServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
}

/**
 * Load MCP server configurations from Cursor-format JSON files.
 * Reads from:
 *   1. MCP_CONFIG_PATH env var (if set)
 *   2. ~/.cursor/mcp.json (user-level Cursor config)
 *
 * Only stdio-type servers are supported (command + args).
 * Disabled servers are excluded.
 */
export function loadMcpServers(): Record<string, McpServerConfig> {
  const configs: Record<string, McpServerConfig> = {};
  const paths = getMcpConfigPaths();

  for (const configPath of paths) {
    const loaded = loadFromFile(configPath);
    for (const [name, config] of Object.entries(loaded)) {
      configs[name] = config;
    }
  }

  const count = Object.keys(configs).length;
  if (count > 0) {
    log.info(`loaded ${count} server(s): ${Object.keys(configs).join(', ')}`);
  }

  return configs;
}

export function getMcpConfigPaths(): string[] {
  const paths: string[] = [];

  const envPath = process.env.MCP_CONFIG_PATH;
  if (envPath && existsSync(envPath)) {
    paths.push(envPath);
  }

  const cursorPath = join(homedir(), '.cursor', 'mcp.json');
  if (existsSync(cursorPath)) {
    paths.push(cursorPath);
  }

  return paths;
}

export function loadFromFile(configPath: string): Record<string, McpServerConfig> {
  const configs: Record<string, McpServerConfig> = {};

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed: CursorMcpFile = JSON.parse(raw);

    if (!parsed.mcpServers) return configs;

    for (const [name, entry] of Object.entries(parsed.mcpServers)) {
      if (entry.disabled) continue;
      if (!entry.command) continue;

      // Only support stdio servers (command + args)
      if (entry.type && entry.type !== 'stdio') {
        log.info(`skipping ${name}: unsupported type '${entry.type}'`);
        continue;
      }

      configs[name] = {
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
      };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`failed to load ${configPath}: ${message}`);
  }

  return configs;
}
