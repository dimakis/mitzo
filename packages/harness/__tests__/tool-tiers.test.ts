import { describe, it, expect } from 'vitest';
import { getToolTier, shouldAutoAllow, getAllowedToolsForMode, applyTierOverrides } from '../src/tool-tiers.js';

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

    it('returns safe for mcp__task-board__ tools', () => {
      expect(getToolTier('mcp__task-board__TaskComplete')).toBe('safe');
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

    it('allows elevated tools in agent and auto modes', () => {
      expect(shouldAutoAllow('Bash', 'agent')).toBe(true);
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

    it('returns safe + standard + elevated for agent mode', () => {
      const allowed = getAllowedToolsForMode('agent');
      expect(allowed).toContain('Read');
      expect(allowed).toContain('Write');
      expect(allowed).toContain('Bash');
    });
  });

  describe('applyTierOverrides', () => {
    it('overrides default tiers', () => {
      applyTierOverrides({ CustomTool: 'safe' });
      expect(getToolTier('CustomTool')).toBe('safe');
      // Reset
      applyTierOverrides({});
    });
  });
});
