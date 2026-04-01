import { describe, it, expect } from 'vitest';
import { getToolTier, shouldAutoAllow, getAllowedToolsForMode } from '../tool-tiers.js';

describe('getToolTier', () => {
  it('classifies read-only tools as safe', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task']) {
      expect(getToolTier(tool)).toBe('safe');
    }
  });

  it('classifies file-write tools as standard', () => {
    for (const tool of ['Write', 'Edit', 'StrReplace', 'EditNotebook']) {
      expect(getToolTier(tool)).toBe('standard');
    }
  });

  it('classifies shell tools as elevated', () => {
    for (const tool of ['Bash', 'Shell']) {
      expect(getToolTier(tool)).toBe('elevated');
    }
  });

  it('returns unknown for unrecognized tools', () => {
    expect(getToolTier('mcp__atlassian__jira_get_issue')).toBe('unknown');
    expect(getToolTier('SomeNewTool')).toBe('unknown');
    expect(getToolTier('')).toBe('unknown');
  });
});

describe('shouldAutoAllow', () => {
  describe('ask mode', () => {
    it('auto-allows safe tools', () => {
      expect(shouldAutoAllow('Read', 'ask')).toBe(true);
      expect(shouldAutoAllow('Grep', 'ask')).toBe(true);
    });

    it('does not auto-allow standard tools', () => {
      expect(shouldAutoAllow('Write', 'ask')).toBe(false);
      expect(shouldAutoAllow('Edit', 'ask')).toBe(false);
    });

    it('does not auto-allow elevated tools', () => {
      expect(shouldAutoAllow('Bash', 'ask')).toBe(false);
    });

    it('does not auto-allow unknown tools', () => {
      expect(shouldAutoAllow('mcp__atlassian__jira_get_issue', 'ask')).toBe(false);
    });
  });

  describe('agent mode', () => {
    it('auto-allows safe tools', () => {
      expect(shouldAutoAllow('Read', 'agent')).toBe(true);
    });

    it('auto-allows standard tools', () => {
      expect(shouldAutoAllow('Write', 'agent')).toBe(true);
      expect(shouldAutoAllow('StrReplace', 'agent')).toBe(true);
    });

    it('does not auto-allow elevated tools', () => {
      expect(shouldAutoAllow('Bash', 'agent')).toBe(false);
      expect(shouldAutoAllow('Shell', 'agent')).toBe(false);
    });

    it('does not auto-allow unknown tools', () => {
      expect(shouldAutoAllow('mcp__atlassian__jira_get_issue', 'agent')).toBe(false);
    });
  });

  describe('auto mode', () => {
    it('auto-allows safe tools', () => {
      expect(shouldAutoAllow('Read', 'auto')).toBe(true);
    });

    it('auto-allows standard tools', () => {
      expect(shouldAutoAllow('Write', 'auto')).toBe(true);
    });

    it('auto-allows elevated tools', () => {
      expect(shouldAutoAllow('Bash', 'auto')).toBe(true);
      expect(shouldAutoAllow('Shell', 'auto')).toBe(true);
    });

    it('does not auto-allow unknown tools', () => {
      expect(shouldAutoAllow('mcp__atlassian__jira_get_issue', 'auto')).toBe(false);
    });
  });
});

describe('getAllowedToolsForMode', () => {
  it('ask mode only includes safe tools', () => {
    const allowed = getAllowedToolsForMode('ask');
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Glob');
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('Bash');
  });

  it('agent mode includes safe + standard tools', () => {
    const allowed = getAllowedToolsForMode('agent');
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Write');
    expect(allowed).toContain('Edit');
    expect(allowed).not.toContain('Bash');
    expect(allowed).not.toContain('Shell');
  });

  it('auto mode includes safe + standard + elevated tools', () => {
    const allowed = getAllowedToolsForMode('auto');
    expect(allowed).toContain('Read');
    expect(allowed).toContain('Write');
    expect(allowed).toContain('Bash');
    expect(allowed).toContain('Shell');
  });
});
