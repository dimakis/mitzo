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
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function cleanUrl(value: string): string {
  return value.replace(/[),.;!?]+$/, '');
}

export function collectSessionResources(
  messages: FinishedMessage[],
  current?: StreamingMessage | null,
): SessionResources {
  const sources: SessionResource[] = [];
  const outputs: SessionResource[] = [];
  const sourceIds = new Set<string>();
  const outputIds = new Set<string>();

  const addSource = (resource: SessionResource) => {
    if (sourceIds.has(resource.id)) return;
    sourceIds.add(resource.id);
    sources.push(resource);
  };
  const addOutput = (resource: SessionResource) => {
    if (outputIds.has(resource.id)) return;
    outputIds.add(resource.id);
    outputs.push(resource);
  };

  const visitBlock = (block: FinishedBlock | StreamingBlock) => {
    if (block.toolName) {
      addSource({ id: `tool:${block.toolName}`, kind: 'tool', label: block.toolName });
    }

    const text = `${block.content ?? ''}\n${block.toolResult ?? ''}`;
    for (const match of text.matchAll(URL_PATTERN)) {
      const href = cleanUrl(match[0]);
      let label = href;
      try {
        const url = new URL(href);
        label = `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
      } catch {
        // Keep the original text when URL parsing fails.
      }
      addOutput({ id: `url:${href}`, kind: 'link', label, href });
    }

    const path = block.rawInput?.path;
    if (path && (block.rawInput?.type === 'write' || block.rawInput?.type === 'diff')) {
      addOutput({ id: `file:${path}`, kind: 'file', label: basename(path), path });
    }

    for (const image of block.toolResultImages ?? []) {
      addOutput({
        id: `result-image:${image.id}`,
        kind: 'image',
        label: 'Generated image',
        imageId: image.id,
      });
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
    for (const block of message.blocks) visitBlock(block);
  }

  if (current) {
    for (const blockId of current.blockOrder) {
      const block = current.blocks.get(blockId);
      if (block) visitBlock(block);
    }
  }

  return { sources, outputs };
}
