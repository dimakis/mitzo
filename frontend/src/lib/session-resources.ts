import type {
  FinishedBlock,
  FinishedMessage,
  StreamingBlock,
  StreamingMessage,
} from '../types/chat';

export interface SessionResource {
  id: string;
  kind: 'context' | 'image' | 'tool' | 'link' | 'file';
  label: string;
  preview?: string;
  href?: string;
  path?: string;
  imageId?: string;
}

export interface SessionResources {
  sources: SessionResource[];
  outputs: SessionResource[];
  references: SessionResource[];
  capabilities: SessionResource[];
}

export function mergeSessionResources(...groups: SessionResources[]): SessionResources {
  const merge = (key: keyof SessionResources) => {
    const seen = new Set<string>();
    return groups.flatMap((group) =>
      group[key].filter((resource) => {
        if (seen.has(resource.id)) return false;
        seen.add(resource.id);
        return true;
      }),
    );
  };

  return {
    sources: merge('sources'),
    outputs: merge('outputs'),
    references: merge('references'),
    capabilities: merge('capabilities'),
  };
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`\]]+/g;

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function cleanUrl(value: string): string {
  let cleaned = value.replace(/[.,;!?]+$/, '');
  while (cleaned.endsWith(')')) {
    const openParens = (cleaned.match(/\(/g) ?? []).length;
    const closeParens = (cleaned.match(/\)/g) ?? []).length;
    if (closeParens <= openParens) break;
    cleaned = cleaned.slice(0, -1).replace(/[.,;!?]+$/, '');
  }
  return cleaned;
}

export function collectSessionResources(
  messages: FinishedMessage[],
  current?: StreamingMessage | null,
): SessionResources {
  const resources: SessionResources = {
    sources: [],
    outputs: [],
    references: [],
    capabilities: [],
  };
  const add = (group: keyof SessionResources, resource: SessionResource) => {
    if (!resources[group].some((existing) => existing.id === resource.id))
      resources[group].push(resource);
  };
  const addSource = (resource: SessionResource) => add('sources', resource);
  const visitBlock = (block: FinishedBlock | StreamingBlock, _role: 'user' | 'assistant') => {
    if (block.toolName)
      add('capabilities', { id: `tool:${block.toolName}`, kind: 'tool', label: block.toolName });
    // Mentions survive as references regardless of role or tool success. They prove no creation.
    for (const match of `${block.content ?? ''}\n${block.toolResult ?? ''}`.matchAll(URL_PATTERN)) {
      const href = cleanUrl(match[0]);
      let label = href;
      try {
        const url = new URL(href);
        label = `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
      } catch {
        /* Preserve historical text. */
      }
      add('references', { id: `url:${href}`, kind: 'link', label, href });
    }
    const path = block.rawInput?.path;
    if (
      block.toolName &&
      block.toolError !== true &&
      block.toolResult !== undefined &&
      path &&
      (block.rawInput?.type === 'write' || block.rawInput?.type === 'diff')
    ) {
      add('references', { id: `file:${path}`, kind: 'file', label: basename(path), path });
    }
    // Result images can be reads/screenshots. Only explicit registration creates an output.
    if (block.subagent) {
      const nestedBlocks = Array.isArray(block.subagent.blocks)
        ? block.subagent.blocks
        : Array.from(block.subagent.blocks.values());
      for (const nestedBlock of nestedBlocks) visitBlock(nestedBlock, 'assistant');
    }
  };

  for (const message of messages) {
    if (message.role === 'user') {
      for (const name of message.contextBlocks ?? []) {
        addSource({ id: `context:${name}`, kind: 'context', label: name });
      }
      for (const [index, preview] of (message.images ?? []).entries()) {
        addSource({
          id: `image:${message.messageId}:${index}`,
          kind: 'image',
          label: `Pasted image ${index + 1}`,
          preview,
        });
      }
    }
    for (const block of message.blocks) visitBlock(block, message.role);
  }

  if (current) {
    for (const blockId of current.blockOrder) {
      const block = current.blocks.get(blockId);
      if (block) visitBlock(block, 'assistant');
    }
  }

  return resources;
}
