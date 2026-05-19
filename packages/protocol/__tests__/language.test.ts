import { describe, it, expect } from 'vitest';
import { languageFromPath } from '../src/language.js';

describe('languageFromPath', () => {
  it('detects TypeScript from .ts extension', () => {
    expect(languageFromPath('/src/index.ts')).toBe('typescript');
  });

  it('detects TypeScript from .tsx extension', () => {
    expect(languageFromPath('components/App.tsx')).toBe('typescript');
  });

  it('detects JavaScript from .js extension', () => {
    expect(languageFromPath('lib/utils.js')).toBe('javascript');
  });

  it('detects Python from .py extension', () => {
    expect(languageFromPath('/home/user/script.py')).toBe('python');
  });

  it('detects bash from .sh extension', () => {
    expect(languageFromPath('deploy.sh')).toBe('bash');
  });

  it('detects JSON', () => {
    expect(languageFromPath('package.json')).toBe('json');
  });

  it('detects YAML from .yml', () => {
    expect(languageFromPath('config.yml')).toBe('yaml');
  });

  it('detects YAML from .yaml', () => {
    expect(languageFromPath('docker-compose.yaml')).toBe('yaml');
  });

  it('detects CSS', () => {
    expect(languageFromPath('styles/global.css')).toBe('css');
  });

  it('detects Rust from .rs', () => {
    expect(languageFromPath('src/main.rs')).toBe('rust');
  });

  it('detects Go from .go', () => {
    expect(languageFromPath('cmd/server/main.go')).toBe('go');
  });

  it('detects Dockerfile by basename', () => {
    expect(languageFromPath('/app/Dockerfile')).toBe('dockerfile');
  });

  it('detects SQL', () => {
    expect(languageFromPath('migrations/001.sql')).toBe('sql');
  });

  it('detects Markdown from .md', () => {
    expect(languageFromPath('README.md')).toBe('markdown');
  });

  it('returns undefined for unknown extension', () => {
    expect(languageFromPath('file.xyz')).toBeUndefined();
  });

  it('returns undefined for extensionless file', () => {
    expect(languageFromPath('LICENSE')).toBeUndefined();
  });

  it('handles deeply nested paths', () => {
    expect(languageFromPath('/a/b/c/d/e/f.py')).toBe('python');
  });

  it('handles dotfiles with known extension', () => {
    expect(languageFromPath('.bashrc')).toBeUndefined(); // no ext after dot
  });
});
