import ReactMarkdown from 'react-markdown';
import { markdownComponents, remarkPlugins } from '../lib/markdown-config';
import { Link } from 'react-router-dom';
import { AgentLibrarySourceContentSchema, type SourceSnapshot } from '@mitzo/protocol';
import { ContextInjectionDisclosure } from './ContextInjectionDisclosure';
import { UiIcon } from './UiIcon';

export function AgentLibraryChatLink({ sources }: { sources?: SourceSnapshot[] }) {
  if (!sources?.some((source) => source.kind === 'agent-library')) return null;
  return (
    <div className="telos-chat-context">
      <Link className="session-work-link" to="/agent-library">
        <UiIcon name="files" size={16} />
        Open Agent Library
      </Link>
    </div>
  );
}

/** The source viewer displays retained input, never a current mutable Library read. */
export function AgentLibrarySourceContext({ sources }: { sources: SourceSnapshot[] }) {
  const source = sources.find((entry) => entry.kind === 'agent-library');
  if (!source) return null;
  let value: unknown;
  try {
    value = JSON.parse(source.content);
  } catch {
    return <p role="alert">Agent Library context unavailable.</p>;
  }
  const parsed = AgentLibrarySourceContentSchema.safeParse(value);
  if (!parsed.success) return <p role="alert">Agent Library context unavailable.</p>;
  const content = parsed.data;
  const provenance =
    content.source.kind === 'published'
      ? `Published · r${content.source.revision}`
      : content.source.draftVersion === null
        ? `Unsaved draft · based on r${content.source.baseRevision}`
        : `Draft · saved ${content.source.draftVersion} · based on r${content.source.baseRevision}`;
  return (
    <ContextInjectionDisclosure
      label="Agent Library context"
      names={[]}
      renderContent={() => (
        <div className="msg-bubble-content">
          {content.definition.descriptor && <p>{content.definition.descriptor}</p>}
          {content.definition.description && (
            <ReactMarkdown components={markdownComponents} remarkPlugins={remarkPlugins}>
              {content.definition.description}
            </ReactMarkdown>
          )}
          <h3>Instructions</h3>
          <ReactMarkdown components={markdownComponents} remarkPlugins={remarkPlugins}>
            {content.definition.instructions || 'No instructions yet.'}
          </ReactMarkdown>
          <h3>Expected output</h3>
          <ReactMarkdown components={markdownComponents} remarkPlugins={remarkPlugins}>
            {content.definition.expectedOutput || 'No expected output yet.'}
          </ReactMarkdown>
          <h3>Acceptance criteria</h3>
          <ul>
            {content.definition.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>{criterion || 'Unfinished criterion'}</li>
            ))}
          </ul>
          <h3>Tools</h3>
          {content.definition.tools?.length ? (
            <ul>
              {content.definition.tools.map((tool) => (
                <li key={tool.id}>
                  <code>{tool.id}</code> · version {tool.version}
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {content.definition.tools === undefined
                ? 'Uses the selected runtime’s default tool catalog.'
                : 'No optional tools selected.'}
            </p>
          )}
          <h3>Context</h3>
          {content.definition.contextRecipe?.source === 'workspace' ? (
            <>
              <p>
                Workspace documents · {content.definition.contextRecipe.tokenBudget} token budget
              </p>
              <ul>
                {content.definition.contextRecipe.files.map((file, index) => (
                  <li key={index}>{file}</li>
                ))}
              </ul>
              {content.definition.contextRecipe.required.length > 0 && (
                <p>
                  Required sections:{' '}
                  {content.definition.contextRecipe.required
                    .map((parts) => parts.join(' › '))
                    .join('; ')}
                </p>
              )}
              {content.definition.contextRecipe.excluded.length > 0 && (
                <p>
                  Excluded sections:{' '}
                  {content.definition.contextRecipe.excluded
                    .map((parts) => parts.join(' › '))
                    .join('; ')}
                </p>
              )}
            </>
          ) : content.definition.contextRecipe?.source === 'packs' ? (
            <ul>
              {content.definition.contextRecipe.packs.map((pack) => (
                <li key={pack.id}>
                  {pack.id} · r{pack.revision} · <code>{pack.hash}</code>
                </li>
              ))}
            </ul>
          ) : content.definition.contextRecipe?.source === 'contexgin' ? (
            <p>ContexGin agent: {content.definition.contextRecipe.agentName}</p>
          ) : (
            <p>No compiled context selected.</p>
          )}
          {content.definition.recipe && (
            <>
              <p>
                Included context: {content.definition.recipe.context.include.join(', ') || 'None'}
              </p>
              <p>
                Context sources: {content.definition.recipe.context.sources.join(', ') || 'None'}
              </p>
              <p>Skills: {content.definition.recipe.skillRefs.join(', ') || 'None'}</p>
              <p>
                Preferred tools:{' '}
                {content.definition.recipe.toolDefaults.preferredTools.join(', ') || 'None'}
              </p>
              <p>
                Compatible providers: {content.definition.recipe.compatibleProviders.join(', ')}
              </p>
            </>
          )}
          {content.reviewedContext && (
            <ReactMarkdown components={markdownComponents} remarkPlugins={remarkPlugins}>
              {content.reviewedContext}
            </ReactMarkdown>
          )}
          <p>
            Role: {content.definition.role} · Model policy role:{' '}
            {content.definition.modelPolicyRole}
          </p>
          <p>
            Source hash: <code>{source.revision}</code>
          </p>
        </div>
      )}
      injections={[
        {
          name: content.definition.name || 'New agent',
          source: `${provenance} · ${content.source.profileId}`,
          content: JSON.stringify(content, null, 2),
        },
      ]}
    />
  );
}
