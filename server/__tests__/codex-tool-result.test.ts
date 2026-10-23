import { describe, expect, it } from 'vitest';
import {
  appendCodexToolFeedback,
  codexToolResultContentItems,
  normalizeCodexToolResult,
  normalizeMcpToolResult,
  type CodexToolResult,
} from '../codex-tool-result.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const image = { type: 'image', mimeType: 'image/png', data: png };

describe('Codex product tool image results', () => {
  it('preserves mixed block order as inline native content and keeps a text projection', () => {
    const result = normalizeMcpToolResult(
      [{ type: 'text', text: 'before' }, image, { type: 'text', text: 'after' }],
      false,
    );
    expect(result).toEqual({
      content: 'before\nafter',
      isError: false,
      contentItems: [
        { type: 'inputText', text: 'before' },
        { type: 'inputImage', imageUrl: `data:image/png;base64,${png}` },
        { type: 'inputText', text: 'after' },
      ],
    });
    expect(codexToolResultContentItems(result)).toEqual(result.contentItems);
  });

  it('preserves legacy text result shapes and creates native text only at delivery', () => {
    const legacy = { content: 'plain', isError: false };
    expect(normalizeMcpToolResult([{ type: 'text', text: 'plain' }], false)).toEqual(legacy);
    expect(normalizeCodexToolResult(legacy)).toEqual(legacy);
    expect(codexToolResultContentItems(legacy)).toEqual([{ type: 'inputText', text: 'plain' }]);
  });

  it('copies payloads before custody and appends hook feedback without losing the image', () => {
    const result = structuredClone(normalizeMcpToolResult([image], false));
    const copied = normalizeCodexToolResult(result);
    result.contentItems![0] = { type: 'inputText', text: 'changed' };
    const withFeedback = appendCodexToolFeedback(copied, 'reviewed');
    expect(withFeedback.content).toBe('\n\nProject hook feedback:\nreviewed');
    expect(withFeedback.contentItems).toEqual([
      { type: 'inputImage', imageUrl: `data:image/png;base64,${png}` },
      { type: 'inputText', text: '\n\nProject hook feedback:\nreviewed' },
    ]);
    expect(copied.contentItems![0].type).toBe('inputImage');
    expect(Object.isFrozen(copied)).toBe(true);
    expect(Object.isFrozen(copied.contentItems)).toBe(true);
    expect(Object.isFrozen(copied.contentItems![0])).toBe(true);
  });

  it.each([
    { ...image, data: 'bad!' },
    { ...image, data: png + '\n' },
    { ...image, mimeType: 'image/jpeg' },
    { ...image, mimeType: 'image/svg+xml' },
    { ...image, data: `data:image/png;base64,${png}` },
    { type: 'image', imageUrl: 'https://example.com/private.png' },
    { type: 'resource_link', uri: 'file:///private/secret' },
    { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' },
    null,
  ])('diagnoses unsupported or invalid output without echoing payloads: %j', (block) => {
    const result = normalizeMcpToolResult([block], false);
    expect(result.isError).toBe(true);
    expect(result.contentItems).toBeUndefined();
    expect(result.content).toMatch(/unsupported|invalid/i);
    expect(result.content).not.toContain('private');
    expect(result.content).not.toContain('AAAA');
  });

  it('bounds aggregate rich results, block count and text including hook feedback', () => {
    expect(
      normalizeMcpToolResult(
        Array.from({ length: 33 }, () => image),
        false,
      ).isError,
    ).toBe(true);
    const tooLarge = { ...image, data: 'A'.repeat(1_048_580) };
    expect(normalizeMcpToolResult([tooLarge], false).content).toMatch(/bound|large/i);
    const bounded = normalizeMcpToolResult(
      [{ type: 'text', text: '😀'.repeat(32_768) }, image],
      false,
    );
    expect(Buffer.byteLength(bounded.content)).toBeLessThanOrEqual(65_536);
    expect(bounded.content).toContain('[Output truncated]');
    expect(() => appendCodexToolFeedback(bounded, 'x'.repeat(65_536))).toThrow(/bound/);
    const imageBytes = Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(80_000)]).toString(
      'base64',
    );
    expect(
      normalizeMcpToolResult(
        Array.from({ length: 12 }, () => ({ ...image, data: imageBytes })),
        false,
      ).isError,
    ).toBe(true);
  });

  it.each([
    { prefix: 'x'.repeat(65_535), trailing: 'required trailing text' },
    { prefix: 'x'.repeat(65_534), trailing: 'é' },
    { prefix: '😀'.repeat(16_383) + 'xxx', trailing: 'Ω' },
  ])(
    'refuses rich output when omitted trailing text cannot be marked (%#)',
    ({ prefix, trailing }) => {
      const result = normalizeMcpToolResult(
        [{ type: 'text', text: prefix }, image, { type: 'text', text: trailing }],
        false,
      );
      expect(result).toEqual({
        content: 'Tool output exceeds the supported result bound. Request a smaller result.',
        isError: true,
      });
    },
  );

  it('preserves the exact UTF-8 multi-block projection at the complete text bound', () => {
    const prefix = 'x'.repeat(65_533);
    const result = normalizeMcpToolResult(
      [{ type: 'text', text: prefix }, image, { type: 'text', text: 'é' }],
      false,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe(`${prefix}\né`);
    expect(Buffer.byteLength(result.content)).toBe(65_536);
    expect(codexToolResultContentItems(result)).toEqual([
      { type: 'inputText', text: prefix },
      { type: 'inputImage', imageUrl: `data:image/png;base64,${png}` },
      { type: 'inputText', text: 'é' },
    ]);
  });

  it('keeps explicit UTF-8-safe truncation when the last block has marker space', () => {
    const result = normalizeMcpToolResult(
      [{ type: 'text', text: 'before' }, image, { type: 'text', text: '😀'.repeat(32_768) }],
      false,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/^before\n😀+\n\[Output truncated\]$/u);
    expect(result.content).not.toContain('\uFFFD');
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(65_536);
    expect(codexToolResultContentItems(result)[1]).toEqual({
      type: 'inputImage',
      imageUrl: `data:image/png;base64,${png}`,
    });
  });

  it('rejects corrupt native payloads rather than downgrading stored rich receipts', () => {
    expect(() =>
      normalizeCodexToolResult({
        content: 'text',
        isError: false,
        contentItems: [{ type: 'inputImage', imageUrl: 'https://example.com/private.png' }],
      }),
    ).toThrow(/invalid/i);
    expect(() =>
      normalizeCodexToolResult({
        content: 'other',
        isError: false,
        contentItems: [{ type: 'inputText', text: 'text' }],
      }),
    ).toThrow(/projection/);
    const unsupportedWireResult: unknown = {
      content: '',
      isError: false,
      contentItems: [{ type: 'inputAudio', audioUrl: 'data:audio/wav;base64,AAAA' }],
    };
    expect(() => normalizeCodexToolResult(unsupportedWireResult as CodexToolResult)).toThrow(
      /invalid/i,
    );
  });

  it('includes text separators in the rich text bound', () => {
    expect(() =>
      normalizeCodexToolResult({
        content: 'x'.repeat(65_536) + '\n',
        isError: false,
        contentItems: [
          { type: 'inputText', text: 'x'.repeat(65_536) },
          { type: 'inputText', text: '' },
        ],
      }),
    ).toThrow(/bound/);
  });

  it('preserves trusted result metadata used by existing environment continuation', () => {
    const original = {
      content: 'attached',
      isError: false,
      environmentChange: { kind: 'provider-attachment', provider: 'github' },
    };
    expect(normalizeCodexToolResult(original)).toMatchObject(original);
  });
});
