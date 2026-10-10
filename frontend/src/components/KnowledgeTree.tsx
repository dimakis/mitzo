import { UiIcon } from './UiIcon';
import { useState, type CSSProperties } from 'react';
function TreeIcon({ kind }: { kind: 'down' | 'right' | 'file' | 'folder' | 'more' }) {
  const names = {
    down: 'down',
    right: 'forward',
    file: 'file',
    folder: 'files',
    more: 'more',
  } as const;
  return <UiIcon name={names[kind]} size={16} />;
}
import type { KnowledgeDocument } from '../types/knowledge';

interface Props {
  documents: KnowledgeDocument[];
  directories: string[];
  search?: string;
  busy?: boolean;
  selectedFolder?: string;
  onFolder(path: string): void;
  onOpen?(document: KnowledgeDocument): void;
  onMore?(document: KnowledgeDocument): void;
  folderChoices?: boolean;
  canSelectFolder?(path: string): boolean;
}
interface Node {
  path: string;
  folders: Node[];
  documents: KnowledgeDocument[];
}
function buildTree(documents: KnowledgeDocument[], directories: string[]): Node {
  const root: Node = { path: '', folders: [], documents: [] };
  const nodes = new Map([['', root]]);
  function folder(path: string): Node {
    const existing = nodes.get(path);
    if (existing) return existing;
    const parent = folder(path.split('/').slice(0, -1).join('/'));
    const node: Node = { path, folders: [], documents: [] };
    nodes.set(path, node);
    parent.folders.push(node);
    return node;
  }
  directories.forEach(folder);
  documents.forEach((document) =>
    folder(document.path.split('/').slice(0, -1).join('/')).documents.push(document),
  );
  return root;
}
export function KnowledgeTree(props: Props) {
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  const query = (props.search || '').trim().toLowerCase();
  const root = buildTree(props.documents, props.directories);
  const match = (document: KnowledgeDocument) =>
    `${document.path} ${document.title}`.toLowerCase().includes(query);
  function visible(node: Node): boolean {
    return (
      !query ||
      node.path.toLowerCase().includes(query) ||
      node.documents.some(match) ||
      node.folders.some(visible)
    );
  }
  function count(node: Node): number {
    return node.documents.length + node.folders.reduce((sum, child) => sum + count(child), 0);
  }
  function rows(node: Node, depth: number, parentMatches = false) {
    const all = parentMatches || (!!query && node.path.toLowerCase().includes(query));
    return (
      <>
        {node.folders
          .sort((a, b) => a.path.localeCompare(b.path))
          .filter((folder) => all || visible(folder))
          .map((folder) => {
            const onSelectedBranch =
              !!props.selectedFolder &&
              (props.selectedFolder === folder.path ||
                props.selectedFolder.startsWith(folder.path + '/'));
            const expanded = !!query || (expansion[folder.path] ?? onSelectedBranch);
            const selectable =
              !props.folderChoices || (props.canSelectFolder?.(folder.path) ?? true);
            return (
              <div key={folder.path}>
                <div
                  className={`knowledge-tree-row${props.selectedFolder === folder.path ? ' knowledge-tree-row--current' : ''}`}
                  style={{ '--tree-depth': depth } as CSSProperties}
                >
                  {props.folderChoices && (
                    <button
                      className="knowledge-tree-toggle"
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} folder ${folder.path}`}
                      aria-expanded={expanded}
                      disabled={props.busy}
                      onClick={() =>
                        setExpansion((previous) => ({ ...previous, [folder.path]: !expanded }))
                      }
                    >
                      {expanded ? <TreeIcon kind="down" /> : <TreeIcon kind="right" />}
                    </button>
                  )}
                  <button
                    className={`knowledge-tree-entry${props.folderChoices ? ' knowledge-tree-entry--choice' : ''}`}
                    aria-label={`Folder ${folder.path}`}
                    aria-expanded={props.folderChoices ? undefined : expanded}
                    aria-pressed={
                      props.folderChoices ? props.selectedFolder === folder.path : undefined
                    }
                    disabled={props.busy || !selectable}
                    aria-disabled={!selectable || undefined}
                    onClick={() => {
                      props.onFolder(folder.path);
                      setExpansion((previous) => ({
                        ...previous,
                        [folder.path]: props.folderChoices ? true : !expanded,
                      }));
                    }}
                  >
                    {!props.folderChoices &&
                      (expanded ? <TreeIcon kind="down" /> : <TreeIcon kind="right" />)}
                    <TreeIcon kind="folder" />
                    <span className="knowledge-tree-title">{folder.path.split('/').pop()}</span>
                    {!props.folderChoices && (
                      <span className="knowledge-tree-count">{count(folder)}</span>
                    )}
                    {props.folderChoices && props.selectedFolder === folder.path && (
                      <span aria-hidden="true">✓</span>
                    )}
                  </button>
                </div>
                {expanded && rows(folder, depth + 1, all)}
                {expanded &&
                  !props.folderChoices &&
                  !folder.folders.length &&
                  !folder.documents.length && (
                    <p
                      className="knowledge-tree-empty workspace-muted"
                      style={{ '--tree-depth': depth + 1 } as CSSProperties}
                    >
                      This folder is empty.
                    </p>
                  )}
              </div>
            );
          })}
        {!props.folderChoices &&
          node.documents
            .filter((document) => all || match(document))
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((document) => (
              <div
                className="knowledge-tree-row"
                key={document.path}
                style={{ '--tree-depth': depth } as CSSProperties}
              >
                <button
                  className="knowledge-tree-entry"
                  disabled={props.busy}
                  onClick={() => props.onOpen?.(document)}
                >
                  <span className="knowledge-tree-spacer" />
                  <TreeIcon kind="file" />
                  <span className="knowledge-tree-title">
                    {document.title}
                    <small>{document.path.split('/').pop()}</small>
                  </span>
                </button>
                {props.onMore && (
                  <button
                    className="knowledge-tree-more"
                    aria-label={`Options for ${document.path}`}
                    disabled={props.busy}
                    onClick={() => props.onMore?.(document)}
                  >
                    <TreeIcon kind="more" />
                  </button>
                )}
              </div>
            ))}
      </>
    );
  }
  return (
    <div
      className="knowledge-tree"
      aria-label={props.folderChoices ? 'Destination folders' : 'Knowledge folders and documents'}
    >
      {rows(root, 0)}
    </div>
  );
}
