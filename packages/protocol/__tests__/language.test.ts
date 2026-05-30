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

  // New language coverage
  it('detects Objective-C from .m', () => {
    expect(languageFromPath('AppDelegate.m')).toBe('objectivec');
  });

  it('detects Dart from .dart', () => {
    expect(languageFromPath('lib/main.dart')).toBe('dart');
  });

  it('detects Scala from .scala', () => {
    expect(languageFromPath('src/Main.scala')).toBe('scala');
  });

  it('detects Haskell from .hs', () => {
    expect(languageFromPath('src/Main.hs')).toBe('haskell');
  });

  it('detects OCaml from .ml', () => {
    expect(languageFromPath('lib/parser.ml')).toBe('ocaml');
  });

  it('detects Clojure from .clj', () => {
    expect(languageFromPath('src/core.clj')).toBe('clojure');
  });

  it('detects ClojureScript from .cljs', () => {
    expect(languageFromPath('src/app.cljs')).toBe('clojure');
  });

  it('detects Elixir from .ex', () => {
    expect(languageFromPath('lib/app.ex')).toBe('elixir');
  });

  it('detects Erlang from .erl', () => {
    expect(languageFromPath('src/server.erl')).toBe('erlang');
  });

  it('detects PowerShell from .ps1', () => {
    expect(languageFromPath('scripts/deploy.ps1')).toBe('powershell');
  });

  it('detects Nix from .nix', () => {
    expect(languageFromPath('flake.nix')).toBe('nix');
  });

  it('detects WASM text from .wat', () => {
    expect(languageFromPath('module.wat')).toBe('wasm');
  });

  it('detects nginx from .conf', () => {
    expect(languageFromPath('/etc/nginx/nginx.conf')).toBe('nginx');
  });
});
