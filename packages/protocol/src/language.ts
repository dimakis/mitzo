// Maps file extensions to highlight.js language identifiers.
// To add a new language:
// 1. Add extension → language mapping here
// 2. Register the language in frontend/src/components/CodeBlock.tsx

const EXT_MAP: Record<string, string> = {
  // JavaScript / TypeScript
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',

  // Python
  py: 'python',
  pyi: 'python',
  pyw: 'python',

  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',

  // Web
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',

  // Data / Config
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',

  // Systems
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  cs: 'csharp',

  // Scripting
  rb: 'ruby',
  lua: 'lua',
  pl: 'perl',
  php: 'php',
  r: 'r',
  R: 'r',

  // Markup / Docs
  md: 'markdown',
  mdx: 'markdown',
  tex: 'latex',
  rst: 'plaintext',

  // Infrastructure
  tf: 'hcl',
  hcl: 'hcl',
  dockerfile: 'dockerfile',

  // SQL
  sql: 'sql',

  // Misc
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  makefile: 'makefile',
  cmake: 'cmake',
};

/**
 * Derive a highlight.js language identifier from a file path.
 * Returns undefined when the extension is unrecognised.
 */
export function languageFromPath(filePath: string): string | undefined {
  // Handle dotfiles and extensionless names like 'Dockerfile', 'Makefile'
  const basename = filePath.split('/').pop() ?? '';
  const lowerBasename = basename.toLowerCase();

  // Check full basename first (Dockerfile, Makefile, etc.)
  if (EXT_MAP[basename]) return EXT_MAP[basename];
  if (EXT_MAP[lowerBasename]) return EXT_MAP[lowerBasename];

  // Then check extension
  const dotIdx = basename.lastIndexOf('.');
  if (dotIdx < 0) return undefined;
  const ext = basename.slice(dotIdx + 1);
  return EXT_MAP[ext];
}
