import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
const contextDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Preloaded, bounded documents: no discovery, service fetches or source grants. */
export async function compileWorkspaceContext(recipe, options, compiler) {
  const { compile, estimateTokens, parseMarkdown } = compiler;
  async function rootIdentity(options) {
    if (!options.workspaceRoot) throw Error('Select a chat workspace for context compilation');
    return realpath(options.workspaceRoot);
  }
  async function document(root, reference, signal) {
    signal?.throwIfAborted();
    let current = root;
    for (const [index, part] of reference.split('/').entries()) {
      current = join(current, part);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      if (info.isSymbolicLink()) throw Error(`Context symlink is unsupported: ${reference}`);
      if (index < reference.split('/').length - 1 && !info.isDirectory())
        throw Error(`Context parent is not a directory: ${reference}`);
      if (index === reference.split('/').length - 1 && !info.isFile())
        throw Error(`Context document is not a regular file: ${reference}`);
    }
    const handle = await open(
      current,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw Error(`Context document is not a regular file: ${reference}`);
      if (info.size > 65536) throw Error(`Context document is too large: ${reference}`);
      const resolved = await realpath(current);
      const within = relative(root, resolved);
      if (within === '..' || within.startsWith('..' + sep) || isAbsolute(within))
        throw Error(`Context document escapes its workspace: ${reference}`);
      const target = await lstat(resolved);
      if (target.dev !== info.dev || target.ino !== info.ino)
        throw Error(`Context document changed during selection: ${reference}`);
      const bytes = Buffer.alloc(65537);
      let size = 0;
      while (size < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
        size += bytesRead;
        if (!bytesRead) break;
      }
      if (size > 65536) throw Error(`Context document is too large: ${reference}`);
      signal?.throwIfAborted();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    } finally {
      await handle.close();
    }
  }
  function node(file, content, headingPath, index, required = false) {
    return {
      id: required ? file : `${file}:${index}`,
      content,
      required,
      type: required ? 'governance' : 'reference',
      tier: required ? 'constitutional' : 'reference',
      tokenEstimate: estimateTokens(content),
      origin: { source: file, relativePath: file, format: 'markdown', headingPath },
    };
  }
  async function workspaceContext(recipe, options) {
    const root = await rootIdentity(options);
    const nodes = [];
    let canonical;
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const content = await document(root, file, options.signal);
      if (content !== null) {
        if (!content.trim()) throw Error(`Required workspace instructions are empty: ${file}`);
        canonical = file;
        nodes.push(node(file, content, [file], 0, true));
        break;
      }
    }
    if (!canonical) throw Error('Required canonical workspace instructions are unavailable');
    for (const file of recipe.files) {
      if (file === canonical || (file === 'CLAUDE.md' && canonical === 'AGENTS.md')) continue;
      const content = await document(root, file, options.signal);
      if (content === null) throw Error(`Selected context document is unavailable: ${file}`);
      const tree = parseMarkdown(content);
      if (!tree.length) {
        if (content.trim()) nodes.push(node(file, content, [file], 0));
      } else {
        const preamble = content
          .split('\n')
          .slice(0, tree[0].line - 1)
          .join('\n');
        if (preamble.trim()) nodes.push(node(file, preamble, [file], 0));
        let index = 1;
        const visit = (heading, parent) => {
          const path = [...parent, heading.title];
          if (heading.content.trim()) nodes.push(node(file, heading.content, path, index++));
          heading.children.forEach((child) => visit(child, path));
        };
        tree.forEach((heading) => visit(heading, [file]));
      }
      if (nodes.length > 500) throw Error('Context documents contain too many sections');
    }
    for (const selector of recipe.excluded) {
      if (canonical && selector[0].toLowerCase() === canonical.toLowerCase())
        throw Error('A context recipe cannot exclude required workspace instructions');
    }
    options.signal?.throwIfAborted();
    const compiled = await compile({
      workspaceRoot: root,
      nodes,
      tokenBudget: recipe.tokenBudget,
      required: recipe.required,
      excluded: recipe.excluded,
    });
    options.signal?.throwIfAborted();
    const sections = (values) =>
      values.map((section) => ({
        source: section.source.relativePath,
        heading: section.headingPath.join(' > '),
        tokens: section.tokenEstimate,
        content: section.content,
      }));
    return {
      workspaceIdentity: contextDigest(root),
      context: {
        type: 'boot_context',
        source: 'contexgin',
        sourceCount: compiled.sources.length,
        tokenCount: compiled.bootTokens,
        tokenBudget: recipe.tokenBudget,
        sources: compiled.sources.map((source) => ({
          path: source.relativePath,
          kind: source.kind,
        })),
        included: sections(compiled.included),
        trimmed: sections(compiled.trimmed),
        fullMarkdown: compiled.bootPayload,
      },
    };
  }
  return workspaceContext(recipe, options);
}
