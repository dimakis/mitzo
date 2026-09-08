import { describe, it, expect, afterEach } from 'vitest';
import {
  getToolTier,
  shouldAutoAllow,
  getAllowedToolsForMode,
  applyTierOverrides,
} from '../src/tool-tiers.js';

describe('tool-tiers', () => {
  describe('getToolTier', () => {
    it('returns safe for Read', () => {
      expect(getToolTier('Read')).toBe('safe');
    });

    it('returns standard for Write', () => {
      expect(getToolTier('Write')).toBe('standard');
    });

    it('returns elevated for Bash', () => {
      expect(getToolTier('Bash')).toBe('elevated');
    });

    it('only auto-allows the read-only task-board status tool', () => {
      expect(getToolTier('mcp__task-board__TaskStatus')).toBe('safe');
      for (const name of ['TaskSet', 'TaskComplete', 'TaskBlock', 'FutureTool']) {
        const tool = `mcp__task-board__${name}`;
        expect(getToolTier(tool)).toBe('unknown');
        for (const mode of ['ask', 'agent', 'auto'] as const) {
          expect(shouldAutoAllow(tool, mode)).toBe(false);
        }
      }
    });

    it('treats local planning as a write and delegated execution as requiring approval', () => {
      expect(getToolTier('TodoWrite')).toBe('standard');
      expect(getToolTier('Task')).toBe('unknown');
      expect(shouldAutoAllow('TodoWrite', 'ask')).toBe(false);
      expect(shouldAutoAllow('TodoWrite', 'agent')).toBe(true);
      expect(shouldAutoAllow('Task', 'auto')).toBe(false);
    });

    it('returns unknown for other mcp tools', () => {
      expect(getToolTier('mcp__jira__search')).toBe('unknown');
    });

    it('returns unknown for unrecognized tools', () => {
      expect(getToolTier('CustomTool')).toBe('unknown');
    });
  });

  describe('shouldAutoAllow', () => {
    it('allows safe tools in all modes', () => {
      expect(shouldAutoAllow('Read', 'ask')).toBe(true);
      expect(shouldAutoAllow('Read', 'agent')).toBe(true);
      expect(shouldAutoAllow('Read', 'auto')).toBe(true);
    });

    it('denies standard tools in ask mode', () => {
      expect(shouldAutoAllow('Write', 'ask')).toBe(false);
    });

    it('allows standard tools in agent and auto modes', () => {
      expect(shouldAutoAllow('Write', 'agent')).toBe(true);
      expect(shouldAutoAllow('Write', 'auto')).toBe(true);
    });

    it('prompts for elevated tools in agent and allows them in auto', () => {
      expect(shouldAutoAllow('Bash', 'agent')).toBe(false);
      expect(shouldAutoAllow('Bash', 'auto')).toBe(true);
    });

    it('denies unknown tools in all modes', () => {
      expect(shouldAutoAllow('mcp__jira__search', 'ask')).toBe(false);
      expect(shouldAutoAllow('mcp__jira__search', 'agent')).toBe(false);
      expect(shouldAutoAllow('mcp__jira__search', 'auto')).toBe(false);
    });
  });

  describe('getAllowedToolsForMode', () => {
    it('returns only safe tools for ask mode', () => {
      const allowed = getAllowedToolsForMode('ask');
      expect(allowed).toContain('Read');
      expect(allowed).not.toContain('Write');
      expect(allowed).not.toContain('Bash');
    });

    it('returns safe + standard for agent mode', () => {
      const allowed = getAllowedToolsForMode('agent');
      expect(allowed).toContain('Read');
      expect(allowed).toContain('Write');
      expect(allowed).not.toContain('Bash');
    });
  });

  describe('applyTierOverrides', () => {
    afterEach(() => {
      applyTierOverrides({});
    });

    it('overrides default tiers', () => {
      applyTierOverrides({ CustomTool: 'safe' });
      expect(getToolTier('CustomTool')).toBe('safe');
    });
  });
});
