import postcss from 'postcss';

// The embedded component has a bounded width, independent of the artifact window.
// Keep production declarations intact and apply only width breakpoints to that box.
export function compactDisplayPreviewCss(css) {
  const root = postcss.parse(css);
  root.walkAtRules('media', (rule) => {
    const replacements = postcss.list.comma(rule.params).map((query) => {
      const terms = query.split(/\s*\band\b\s*/);
      const width = terms.filter((term) => /^\(\s*(?:min-|max-)?width\s*:/.test(term));
      if (!width.length) return rule.clone({ params: query });
      const container = postcss.atRule({
        name: 'container',
        params: `compact-preview ${width.join(' and ')}`,
      });
      const remaining = terms.filter((term) => !width.includes(term));
      if (remaining.length) container.append(rule.clone({ params: remaining.join(' and ') }));
      else container.append(rule.nodes.map((node) => node.clone()));
      return container;
    });
    rule.replaceWith(...replacements);
  });
  return root.toString();
}
