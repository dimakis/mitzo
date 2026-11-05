import { expect, it } from 'vitest';
import postcss from 'postcss';
import { compactDisplayPreviewCss } from '../compact-display-preview-css.mjs';

it('uses the preview container for phone and desktop breakpoints', () => {
  const css = compactDisplayPreviewCss(
    '@media (max-width:767px){.masthead{height:64px}}' +
      '@media (min-width:768px) and (max-width:1199px){.rail{width:144px}}',
  );
  const rules: string[] = [];
  postcss.parse(css).walkAtRules('container', (rule) => {
    rules.push(rule.params);
  });
  expect(rules).toEqual([
    'compact-preview (max-width:767px)',
    'compact-preview (min-width:768px) and (max-width:1199px)',
  ]);
});

it('retains pointer and motion media conditions independently of preview width', () => {
  const css = compactDisplayPreviewCss(
    '@media (min-width:601px) and (hover:hover) and (pointer:fine){.control{height:32px}}' +
      '@media (prefers-reduced-motion:reduce){.motion{animation:none}}',
  );
  const root = postcss.parse(css);
  const container = root.nodes[0] as postcss.AtRule;
  expect(container.name).toBe('container');
  expect(container.params).toBe('compact-preview (min-width:601px)');
  expect((container.nodes![0] as postcss.AtRule).params).toBe('(hover:hover) and (pointer:fine)');
  expect((root.nodes[1] as postcss.AtRule).params).toBe('(prefers-reduced-motion:reduce)');
});

it('preserves comma-separated breakpoint alternatives', () => {
  const css = compactDisplayPreviewCss(
    '@media (max-width:380px), (min-width:1200px){.label{display:none}}',
  );
  const containers: string[] = [];
  postcss.parse(css).walkAtRules('container', (rule) => {
    containers.push(rule.params);
  });
  expect(containers).toEqual([
    'compact-preview (max-width:380px)',
    'compact-preview (min-width:1200px)',
  ]);
});
