import type {
  FinishedBlock,
  FinishedMessage,
  StreamingBlock,
  StreamingMessage,
} from '../types/chat';

export type ReferenceRole = 'user' | 'research' | 'cited' | 'created' | 'workspace';
export const REFERENCE_ROLES: Record<ReferenceRole, string> = {
  user: 'Shared by you',
  research: 'Found during research',
  cited: 'Linked by the agent',
  created: 'Created by the agent',
  workspace: 'Workspace references',
};
export interface SessionResource {
  id: string;
  kind: 'context' | 'image' | 'tool' | 'link' | 'file';
  label: string;
  preview?: string;
  content?: string;
  href?: string;
  path?: string;
  imageId?: string;
  roles?: ReferenceRole[];
  mentions?: number;
  messageIds?: string[];
  pullRequest?: {
    state: 'Open' | 'Closed' | 'Merged' | 'Draft';
    observedAt?: number;
    commit?: string;
  };
}

export interface SessionResources {
  sources: SessionResource[];
  outputs: SessionResource[];
  references: SessionResource[];
  capabilities: SessionResource[];
}

export function mergeSessionResources(...groups: SessionResources[]): SessionResources {
  const merge = (key: keyof SessionResources) => {
    const records = new Map<string, SessionResource>();
    for (const group of groups)
      for (const resource of group[key]) {
        const previous = records.get(resource.id);
        records.set(resource.id, previous ? mergeResource(previous, resource) : resource);
      }
    return [...records.values()];
  };

  return {
    sources: merge('sources'),
    outputs: merge('outputs'),
    references: merge('references'),
    capabilities: merge('capabilities'),
  };
}
function mergeResource(a: SessionResource, b: SessionResource): SessionResource {
  return {
    ...a,
    ...b,
    roles: [...new Set([...(a.roles ?? []), ...(b.roles ?? [])])],
    mentions: (a.mentions ?? 0) + (b.mentions ?? 0),
    messageIds: [...new Set([...(a.messageIds ?? []), ...(b.messageIds ?? [])])],
    pullRequest: b.pullRequest ?? a.pullRequest,
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
    const index = resources[group].findIndex((existing) => existing.id === resource.id);
    if (index < 0) resources[group].push(resource);
    else resources[group][index] = mergeResource(resources[group][index], resource);
  };
  const addSource = (resource: SessionResource) => add('sources', resource);
  const visitBlock = (
    block: FinishedBlock | StreamingBlock,
    role: 'user' | 'assistant',
    messageId: string,
  ) => {
    if (block.toolName)
      add('capabilities', { id: `tool:${block.toolName}`, kind: 'tool', label: block.toolName });
    // Mentions survive as references regardless of role or tool success. They prove no creation.
    for (const [text, source] of [
      [block.content ?? '', role === 'user' ? 'user' : 'cited'],
      [block.toolResult ?? '', 'research'],
    ] as const)
      for (const match of text.matchAll(URL_PATTERN)) {
        const href = cleanUrl(match[0]);
        let label = href;
        try {
          const url = new URL(href);
          label = `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
        } catch {
          /* Preserve historical text. */
        }
        add('references', {
          id: `url:${href}`,
          kind: 'link',
          label,
          href,
          roles: [source],
          mentions: 1,
          messageIds: [messageId],
        });
      }
    // Only structured successful publishing evidence can add PR state; a URL alone cannot.
    if (
      block.toolName?.endsWith('RequestGithubPublish') &&
      block.toolError !== true &&
      block.toolResult
    ) {
      try {
        const parsed = JSON.parse(block.toolResult);
        const value =
          parsed.status === 'succeeded' && parsed.result && typeof parsed.result === 'object'
            ? parsed.result
            : parsed;
        const state = value.pullRequestState;
        const href = value.pullRequestUrl;
        if (
          typeof href === 'string' &&
          /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(href) &&
          ['open', 'closed'].includes(state)
        ) {
          const item = resources.references.find((reference) => reference.href === href);
          if (item)
            item.pullRequest = {
              state:
                value.merged === true
                  ? 'Merged'
                  : state === 'closed'
                    ? 'Closed'
                    : value.draft === true
                      ? 'Draft'
                      : 'Open',
              observedAt: typeof value.observedAt === 'number' ? value.observedAt : undefined,
              commit: typeof value.sourceOid === 'string' ? value.sourceOid : undefined,
            };
          if (item && value.created === true)
            item.roles = [...new Set([...(item.roles ?? []), 'created' as const])];
        }
      } catch {
        /* Historical or unstructured results stay unknown. */
      }
    }
    const path = block.rawInput?.path;
    if (
      block.toolName &&
      block.toolError !== true &&
      block.toolResult !== undefined &&
      path &&
      (block.rawInput?.type === 'write' || block.rawInput?.type === 'diff')
    ) {
      add('references', {
        id: `file:${path}`,
        kind: 'file',
        label: basename(path),
        path,
        roles: ['workspace'],
        mentions: 1,
        messageIds: [messageId],
      });
    }
    // Result images can be reads/screenshots. Only explicit registration creates an output.
    if (block.subagent) {
      const nestedBlocks = Array.isArray(block.subagent.blocks)
        ? block.subagent.blocks
        : Array.from(block.subagent.blocks.values());
      for (const nestedBlock of nestedBlocks) visitBlock(nestedBlock, 'assistant', messageId);
    }
  };

  for (const message of messages) {
    if (message.role === 'user') {
      for (const name of message.contextBlocks ?? []) {
        const injection = message.contextInjections?.find((item) => item.name === name);
        addSource({
          id: `context:${message.messageId}:${name}`,
          kind: 'context',
          label: name,
          content: injection?.content,
          path: injection?.source,
          messageIds: [message.messageId],
        });
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
    for (const block of message.blocks) visitBlock(block, message.role, message.messageId);
  }

  if (current) {
    for (const blockId of current.blockOrder) {
      const block = current.blocks.get(blockId);
      if (block) visitBlock(block, 'assistant', current.messageId);
    }
  }

  return resources;
}
