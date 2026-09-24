import React from 'react';
import { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import {
  artifactViewerUrl,
  decodeFilePathUrl,
  FILE_SCHEME,
  linkedArtifactPath,
} from './file-paths';

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'file-path'],
  },
};

/** Preserve internal artifact links while retaining ReactMarkdown's URL filtering. */
export const artifactUrlTransform = (url: string) =>
  url.startsWith(FILE_SCHEME) ? url : defaultUrlTransform(url);

export const remarkPlugins: PluggableList = [remarkGfm];
export const rehypePlugins: PluggableList = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

export const markdownComponents: Components = {
  table: ({ children, ...props }) => (
    <div className="table-scroll-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
};

/** Keep file links inside an artifact bound to the workspace that supplied it. */
export function artifactMarkdownComponents(
  containingFile: string,
  sessionId: string | undefined,
  from: string,
  onOpen: (viewerUrl: string) => void,
): Components {
  return {
    ...markdownComponents,
    a: ({ href, children, title }) => {
      const filePath = href?.startsWith(FILE_SCHEME)
        ? decodeFilePathUrl(href)
        : href
          ? linkedArtifactPath(href, containingFile)
          : null;
      if (href?.startsWith(FILE_SCHEME) && !filePath) return <span>{children}</span>;
      if (!filePath)
        return (
          <a href={href} title={title}>
            {children}
          </a>
        );

      const viewerUrl = artifactViewerUrl(filePath, from, sessionId);
      return (
        <a
          href={viewerUrl}
          title={title}
          onClick={(event) => {
            event.preventDefault();
            onOpen(viewerUrl);
          }}
        >
          {children}
        </a>
      );
    },
  };
}
