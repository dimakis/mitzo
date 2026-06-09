import React from 'react';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import type { Components } from 'react-markdown';
import type { PluggableList } from 'unified';

export const remarkPlugins: PluggableList = [remarkGfm];
export const rehypePlugins: PluggableList = [rehypeRaw, rehypeSanitize];

export const markdownComponents: Components = {
  table: ({ children, ...props }) => (
    <div className="table-scroll-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
};
