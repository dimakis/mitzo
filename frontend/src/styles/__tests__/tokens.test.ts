// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import ts from 'typescript';

const css = readFileSync(resolve(__dirname, '../tokens.css'), 'utf-8');

// Extract :root block content
const rootMatch = css.match(/:root\s*\{([^}]+)\}/);
const rootBlock = rootMatch?.[1] ?? '';

// Exercise the same scanner with hostile snippets and the complete production tree.
const ownedTokens = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
const colorProbe = document.createElement('span').style;
const paintKeywordCache = new Map<string, boolean>();
const neutralColorKeywords = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);

function parsesAsColor(value: string): boolean {
  colorProbe.color = '';
  colorProbe.color = value;
  return colorProbe.color !== '';
}

function hasPaletteLiteral(value: string): boolean {
  const clean = value.replace(/url\([\s\S]*?\)/gi, '');
  if (/#[\da-f]{3,8}\b|(?:rgba?|hsla?|lab|lch|oklab|oklch|color)\s*\(/i.test(clean)) return true;
  for (const word of clean.matchAll(/[-_a-zA-Z][\w-]*/g)) {
    const keyword = word[0].toLowerCase();
    if (neutralColorKeywords.has(keyword)) continue;
    if (!paintKeywordCache.has(keyword)) paintKeywordCache.set(keyword, parsesAsColor(keyword));
    if (paintKeywordCache.get(keyword)) return true;
  }
  return false;
}

const themeDefinitions = [...css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)];
const colorTokens = new Set(
  themeDefinitions
    .filter(
      (match) =>
        !/font/.test(match[1]) && !/var\(/.test(match[2]) && parsesAsColor(match[2].trim()),
    )
    .map((match) => match[1]),
);
for (let changed = true; changed;) {
  changed = false;
  for (const match of themeDefinitions) {
    const references = [...match[2].matchAll(/var\(\s*(--[\w-]+)/g)].map(
      (reference) => reference[1],
    );
    if (
      !colorTokens.has(match[1]) &&
      references.length &&
      references.every((reference) => colorTokens.has(reference))
    ) {
      colorTokens.add(match[1]);
      changed = true;
    }
  }
}
const paintProperty =
  /^(?:color|fill|stroke|background.*|border.*|outline.*|box-?shadow|text-?shadow|caret-?color|accent-?color|text-?decoration-?color|--[\w-]+)$/i;

const fontRoles = [...ownedTokens].filter((name) =>
  /^--font-|^--ui-font$|^--code-font$/.test(name),
);
const fontVariable = String.raw`var\(\s*(?:${fontRoles.join('|')})(?:,\s*(?:monospace|serif|sans-serif|system-ui))?\s*\)`;
const sharedVariable = String.raw`var\(\s*(?:${[...ownedTokens].join('|')})\s*\)`;
const fontFamily = new RegExp(`^(?:${fontVariable}|inherit)$`);
const fontShorthand = new RegExp(
  `^(?:inherit|(?:(?:${sharedVariable}|[\\d.]+(?:px|rem|em|%)?|normal|italic|oblique|bold|bolder|lighter|small-caps)[\\s/]+)*${fontVariable})$`,
);

// Legacy collection/chat scopes remap these roles to the common workspace theme.
// Shared scales, font roles and canonical colors are never redefined by a page.
const contextualAliases = new Set([
  '--bg',
  '--surface',
  '--text',
  '--text-dim',
  '--border',
  '--accent',
  '--bg-primary',
  '--bg-secondary',
  '--text-primary',
  '--text-secondary',
]);

function allowedContextAlias(property: string, value: string | null): boolean {
  if (!contextualAliases.has(property) || value === null) return false;
  const clean = value.trim();
  const reference = clean.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (reference) return colorTokens.has(reference[1]);
  const role = String.raw`var\(\s*--[\w-]+\s*\)`;
  const weight = String.raw`(?:\s+\d+(?:\.\d+)?%)?`;
  const mix = new RegExp(
    `^color-mix\\(\\s*in\\s+srgb\\s*,\\s*${role}${weight}\\s*,\\s*${role}${weight}\\s*\\)$`,
  );
  return (
    mix.test(clean) &&
    [...clean.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].every((match) => colorTokens.has(match[1]))
  );
}

type InlineStyle = { property: string; value: string | null; styleContext: boolean };

function literalStyleValue(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return literalStyleValue(node.expression);
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return node.getText();
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalStyleValue(node.left);
    const right = literalStyleValue(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans
        .map(
          (span) => (literalStyleValue(span.expression) ?? '__dynamic_style__') + span.literal.text,
        )
        .join('')
    );
  }
  return null;
}

function literalStyleAlternatives(node: ts.Node): string[] {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return literalStyleAlternatives(node.expression);
  if (ts.isConditionalExpression(node))
    return [
      ...literalStyleAlternatives(node.whenTrue),
      ...literalStyleAlternatives(node.whenFalse),
    ];
  if (ts.isBinaryExpression(node)) {
    const left = literalStyleAlternatives(node.left);
    const right = literalStyleAlternatives(node.right);
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (!left.length && !right.length) return [];
      return (left.length ? left : ['__dynamic_style__']).flatMap((a) =>
        (right.length ? right : ['__dynamic_style__']).map((b) => a + b),
      );
    }
    if (
      [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(node.operatorToken.kind)
    )
      return [...left, ...right];
  }
  const value = literalStyleValue(node);
  return value === null ? [] : [value];
}

function isStyleContext(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxAttribute(parent) && parent.name.getText() === 'style') return true;
    if (ts.isVariableDeclaration(parent) && /style/i.test(parent.name.getText())) return true;
    if (ts.isAsExpression(parent) && /CSSProperties/.test(parent.type.getText())) return true;
    if (ts.isPropertyAssignment(parent) && parent.name.getText().replace(/['"]/g, '') === 'style')
      return true;
  }
  return false;
}

function styleSources(source: string, filename: string): { css: string[]; inline: InlineStyle[] } {
  if (filename.endsWith('.css')) return { css: [source], inline: [] };
  const css: string[] = [];
  const inline: InlineStyle[] = [];
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) css.push(node.text);
    if (ts.isTemplateExpression(node)) css.push(literalStyleValue(node)!);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const value = literalStyleValue(node);
      if (value !== null) css.push(value);
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
    ) {
      const values = literalStyleAlternatives(node.initializer);
      for (const value of values.length ? values : [null])
        inline.push({ property: node.name.text, value, styleContext: isStyleContext(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return { css, inline };
}

function isGuardedSource(path: string): boolean {
  const root = resolve(__dirname, '../..');
  return (
    /\.(css|tsx?)$/.test(path) &&
    path !== resolve(__dirname, '../tokens.css') &&
    !path.includes('/__tests__/') &&
    !path.startsWith(resolve(root, 'preview') + '/')
  );
}

function styleViolations(source: string, filename = 'component.css'): string[] {
  const violations: string[] = [];
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const sources = styleSources(clean, filename);
  const styleTexts = sources.css;
  for (const styleText of styleTexts) {
    for (const definition of styleText.matchAll(
      /(?:^|[;{])\s*(--[\w-]+)\s*:\s*([^;}]+)(?=[;}]|$)/g,
    )) {
      if (ownedTokens.has(definition[1]) && !allowedContextAlias(definition[1], definition[2]))
        violations.push(`token override: ${definition[1]}`);
    }
  }
  if (/#[\da-f]{3,8}\b|(?:rgba?|hsla?)\s*\(/i.test(clean)) violations.push('palette literal');
  if (/(?:color|background(?:-color)?|fill|stroke):\s*['"]?(?:white|black)\b/i.test(clean))
    violations.push('named color');
  for (const styleText of styleTexts) {
    for (const declaration of styleText.matchAll(
      /(?:^|[;{])\s*([\w-]+)\s*:\s*([^;}]+)(?=[;}]|$)/g,
    )) {
      if (paintProperty.test(declaration[1]) && hasPaletteLiteral(declaration[2]))
        violations.push('palette literal');
    }
  }
  for (const styleText of styleTexts) {
    for (const font of styleText.matchAll(
      /(?:^|[;{])\s*(font-family|font)\s*:\s*([^;}]+)(?=[;}]|$)/g,
    )) {
      const allowed = font[1] === 'font' ? fontShorthand : fontFamily;
      if (!allowed.test(font[2].trim())) violations.push('font stack');
    }
  }
  for (const { property, value, styleContext } of sources.inline) {
    if (value !== null && paintProperty.test(property) && hasPaletteLiteral(value))
      violations.push('palette literal');
    if (ownedTokens.has(property) && !allowedContextAlias(property, value))
      violations.push(`inline token override: ${property}`);
    if (value !== null && (property === 'fontFamily' || property === 'font')) {
      // A preference DTO's `font: 'system'` is data, not a CSS shorthand.
      if (
        property === 'font' &&
        !styleContext &&
        !/\s|var\(|^(?:inherit|caption|icon|menu|message-box|small-caption|status-bar)$/.test(value)
      )
        continue;
      const allowed = property === 'font' ? fontShorthand : fontFamily;
      if (!allowed.test(value.trim())) violations.push('inline font stack');
    }
  }
  return violations;
}

describe('design tokens', () => {
  it('keeps the theme and font definitions in one file', () => {
    const root = resolve(__dirname, '../../');
    const files = readdirSync(root, { recursive: true, withFileTypes: true });
    for (const file of files) {
      const path = resolve(file.parentPath, file.name);
      if (!file.isFile() || !isGuardedSource(path)) continue;
      const source = readFileSync(resolve(file.parentPath, file.name), 'utf8');
      expect(styleViolations(source, file.name), file.name).toEqual([]);
    }
  });
  describe('the source guard catches alternate ways to bypass shared tokens', () => {
    it.each([
      ['inline font', "const style = { fontFamily: 'Arial, sans-serif' };"],
      ['CSS font shorthand', '.new-page { font: 16px Arial; }'],
      ['HSL color', '.new-page { color: hsl(270 90% 70%); }'],
      ['spacing override', '.new-page { --space-4: 17px; }'],
      ['last declaration without semicolon', '.new-page { --space-4: 17px }'],
      ['inline token override', "const style = { '--space-4': '17px' };"],
      ['radius override', '.new-page { --radius-panel: 23px; }'],
      ['type override', '.new-page { --text-base: 19px; }'],
      ['page gutter override', '.new-page { --page-gutter: 27px; }'],
      ['mobile navigation override', '.new-page { --mobile-tabs-height: 91px; }'],
    ])('rejects %s', (_name, source) => {
      expect(
        styleViolations(source, source.startsWith('const ') ? 'page.tsx' : 'component.css').length,
      ).toBeGreaterThan(0);
    });

    it.each([
      '.page { font: var(--text-base) Arial, sans-serif; }',
      '.page { font: var(--text-base)/1.4 Arial; }',
      '.page { font-family: var(--font-ui), Arial; }',
    ])('rejects font literals following a variable: %s', (source) => {
      expect(styleViolations(source)).toContain('font stack');
    });

    it('rejects shared token literals in embedded TSX CSS', () => {
      expect(styleViolations('const styles = `.page { --space-4: 17px; }`;', 'page.tsx')).toContain(
        'token override: --space-4',
      );
    });

    it('rejects variable-prefixed font shorthand embedded in TSX', () => {
      expect(
        styleViolations('const styles = `.page { font: var(--text-base) Arial; }`;', 'page.tsx'),
      ).toContain('font stack');
    });

    it('rejects literal font families supplied by template interpolation', () => {
      expect(
        styleViolations(
          "const styles = `.page { font-family: ${'Arial,'} var(--font-ui); }`;",
          'page.tsx',
        ),
      ).toContain('font stack');
    });

    it('allows an interpolated static token font family', () => {
      expect(
        styleViolations(
          "const styles = `.page { font-family: ${'var(--font-ui)'}; }`;",
          'page.tsx',
        ),
      ).toEqual([]);
    });

    it.each([
      "const element = <div style={{ font: '16px Arial, sans-serif' }} />;",
      "const element = <div style={{ 'font': 'var(--text-base) Arial' }} />;",
    ])('rejects inline font shorthand stacks: %s', (source) => {
      expect(styleViolations(source, 'page.tsx')).toContain('inline font stack');
    });

    it('allows token-based React font shorthand', () => {
      expect(
        styleViolations(
          "const element = <div style={{ font: '600 var(--text-base)/1.4 var(--font-ui)' }} />;",
          'page.tsx',
        ),
      ).toEqual([]);
    });

    it('rejects interpolated inline font stacks', () => {
      expect(
        styleViolations(
          "const element = <div style={{ fontFamily: `${'Arial,'}${fallback}` }} />;",
          'page.tsx',
        ),
      ).toContain('inline font stack');
    });

    it('rejects numeric inline overrides of shared tokens', () => {
      expect(
        styleViolations("const element = <div style={{ '--space-4': 0 }} />;", 'page.tsx'),
      ).toContain('inline token override: --space-4');
    });

    it('exempts only the canonical token file, not feature token files', () => {
      expect(isGuardedSource(resolve(__dirname, '../tokens.css'))).toBe(false);
      expect(isGuardedSource(resolve(__dirname, '../../features/reports/tokens.css'))).toBe(true);
    });

    it.each([
      "const element = <div style={{ fontFamily: selected ? 'Arial' : 'Georgia' }} />;",
      "const element = <div style={{ fontFamily: ('Arial' as const) }} />;",
      "const element = <div style={{ fontFamily: fallback ?? 'Arial' }} />;",
      "const element = <div style={{ fontFamily: 'Arial,' + fallback }} />;",
    ])('rejects fonts hidden in expression branches: %s', (source) => {
      expect(styleViolations(source, 'page.tsx')).toContain('inline font stack');
    });

    it('allows conditional token fonts', () => {
      expect(
        styleViolations(
          "const element = <div style={{ fontFamily: selected ? 'var(--font-ui)' : 'var(--font-mono)' }} />;",
          'page.tsx',
        ),
      ).toEqual([]);
    });

    it.each(['.page { --space-4: var(--space-1); }', '.page { --font-ui: var(--font-mono); }'])(
      'keeps shared scales and font roles owned centrally: %s',
      (source) => {
        expect(styleViolations(source).length).toBeGreaterThan(0);
      },
    );

    it('rejects inline aliases that override shared spacing', () => {
      expect(
        styleViolations(
          "const element = <div style={{ '--space-4': 'var(--space-1)' }} />;",
          'page.tsx',
        ),
      ).toContain('inline token override: --space-4');
    });

    it('rejects named colors inside a legacy role color mix', () => {
      expect(styleViolations('.page { --bg: color-mix(in srgb, red, blue); }')).toContain(
        'token override: --bg',
      );
    });

    it('allows the existing token-based legacy role color mix', () => {
      expect(
        styleViolations(
          '.page { --bg-secondary: color-mix(in srgb, var(--workspace-bg) 96%, var(--workspace-text)); }',
        ),
      ).toEqual([]);
    });

    it('requires direct contextual aliases to reference a registered token', () => {
      expect(styleViolations('.page { --bg: var(--private-palette); }')).toContain(
        'token override: --bg',
      );
    });

    it.each([
      '.page { --space-4 : 17px; }',
      '.page { font-family : Arial; }',
      '.page { font : var(--text-base) Arial; }',
    ])('handles CSS whitespace before a declaration colon: %s', (source) => {
      expect(styleViolations(source).length).toBeGreaterThan(0);
    });

    it.each([
      '.page { --private-font: Arial; font-family: var(--private-font); }',
      '.page { font: var(--text-base) var(--private-font); }',
    ])('requires font variables to come from the shared font registry: %s', (source) => {
      expect(styleViolations(source)).toContain('font stack');
    });

    it('rejects a spacing token used as a contextual color', () => {
      expect(styleViolations('.page { --bg: var(--space-4); }')).toContain('token override: --bg');
    });

    it.each([
      '.page { color: rebeccapurple; }',
      '.page { background: red; }',
      '.page { background: linear-gradient(red, blue); }',
      '.page { color: hsl(-30 90% 70%); }',
      '.page { color: hsl(.5turn 90% 70%); }',
    ])('rejects literal palette values: %s', (source) => {
      expect(styleViolations(source).length).toBeGreaterThan(0);
    });

    it('rejects named colors in React styles', () => {
      expect(
        styleViolations(
          "const element = <div style={{ color: 'rebeccapurple', background: 'red' }} />;",
          'page.tsx',
        ),
      ).toContain('palette literal');
    });

    it('checks statically concatenated CSS template content', () => {
      expect(
        styleViolations("const styles = `.page { ${'font-family:' + 'Arial;'} }`;", 'page.tsx'),
      ).toContain('font stack');
    });

    it('keeps image URL names and inherited colors usable', () => {
      expect(
        styleViolations(".page { background: url('/assets/red.png'); color: currentColor; }"),
      ).toEqual([]);
    });

    it('rejects non-color tokens inside a contextual color mix', () => {
      expect(
        styleViolations('.page { --bg: color-mix(in srgb, var(--space-4), var(--font-ui)); }'),
      ).toContain('token override: --bg');
    });

    it('checks standalone statically concatenated CSS expressions', () => {
      expect(
        styleViolations("const styles = '.page { font-family:' + 'Arial; }';", 'page.tsx'),
      ).toContain('font stack');
    });

    it('allows token-based shorthand size and family', () => {
      expect(styleViolations('.page { font: 600 var(--text-base)/1.4 var(--font-ui); }')).toEqual(
        [],
      );
    });

    it('rejects CSS font-family literals embedded in TSX', () => {
      expect(
        styleViolations('const styles = `.page { font-family: Arial; }`;', 'page.tsx'),
      ).toContain('font stack');
    });

    it('does not confuse adapter token lookup expressions with CSS declarations', () => {
      expect(
        styleViolations(
          'const match = css.match(/--seat-color-default:\\s*([^;]+);/);',
          'adapter.ts',
        ),
      ).toEqual([]);
    });

    it('does not confuse selector modifiers with token declarations', () => {
      expect(styleViolations(".status--active::before { content: ''; }")).toEqual([]);
    });

    it('allows semantic aliases, inherited fonts and token-based inline fonts', () => {
      expect(
        styleViolations(`
        .new-page {
          --text-primary: var(--workspace-text);
          padding: var(--space-4);
          font-family: inherit;
          font: inherit;
          color: color-mix(in srgb, var(--color-accent) 20%, transparent);
        }
        const style = { fontFamily: 'var(--font-ui)' };
      `),
      ).toEqual([]);
    });
  });

  describe('required CSS variables are defined in :root', () => {
    const requiredVars = [
      '--ui-font',
      '--bg',
      '--surface',
      '--color-preview-canvas',
      '--border',
      '--text',
      '--text-dim',
      '--text-secondary',
      '--accent',
      '--accent-hover',
      '--danger',
      '--success',
      '--warning',
      '--bg-secondary',
      '--hover',
      '--active',
    ];

    for (const v of requiredVars) {
      it(`defines ${v}`, () => {
        expect(rootBlock).toContain(`${v}:`);
      });
    }
  });

  describe('type scale variables', () => {
    const typeVars = [
      '--text-2xs',
      '--text-xxs',
      '--text-xs',
      '--text-s',
      '--text-sm',
      '--text-md',
      '--text-base',
      '--text-lg',
      '--text-xl',
    ];

    for (const v of typeVars) {
      it(`defines ${v}`, () => {
        expect(rootBlock).toContain(`${v}:`);
      });
    }
  });

  describe('spacing scale variables', () => {
    const spaceVars = [
      '--space-1',
      '--space-1h',
      '--space-2',
      '--space-3',
      '--space-4',
      '--space-5',
      '--space-6',
    ];

    for (const v of spaceVars) {
      it(`defines ${v}`, () => {
        expect(rootBlock).toContain(`${v}:`);
      });
    }
  });

  describe('no hardcoded colors for themed values', () => {
    // These specific hex values should use CSS vars instead
    const bannedColors = [
      { hex: '#e53935', replacement: 'var(--danger)' },
      { hex: '#ff9800', replacement: 'var(--warning)' },
    ];

    for (const { hex, replacement } of bannedColors) {
      it(`does not use hardcoded ${hex} (use ${replacement})`, () => {
        // Strip the :root block — definitions there are fine
        const withoutRoot = css.replace(/:root\s*\{[^}]+\}/, '');
        expect(withoutRoot).not.toContain(hex);
      });
    }
  });
});
