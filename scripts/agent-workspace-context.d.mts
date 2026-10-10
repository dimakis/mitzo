import type { AgentContextRecipe, CompiledAgentContext } from '@mitzo/protocol';
export function compileWorkspaceContext(
  recipe: Extract<AgentContextRecipe, { source: 'workspace' }>,
  options: { workspaceRoot?: string; signal?: AbortSignal },
  compiler: Pick<typeof import('contexgin'), 'compile' | 'estimateTokens' | 'parseMarkdown'>,
): Promise<{ workspaceIdentity: string; context: CompiledAgentContext['context'] }>;
