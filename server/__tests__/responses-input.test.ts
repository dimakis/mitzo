import { describe, expect, it } from 'vitest';
import { responsesUserContent } from '../responses-input.js';

describe('responsesUserContent', () => {
  it('preserves text-only prompts as strings', () => {
    expect(responsesUserContent('hello')).toBe('hello');
    expect(responsesUserContent('', [])).toBe('');
  });

  it('keeps text and image order in provider-neutral blocks', () => {
    expect(
      responsesUserContent('Compare these', [
        { data: 'aGVsbG8=', mediaType: 'image/png' },
        { data: 'aGk=', mediaType: 'image/jpeg' },
      ]),
    ).toEqual([
      { type: 'text', text: 'Compare these' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGk=' } },
    ]);
  });

  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
    'supports image-only %s input without adding an empty text block',
    (mediaType) => {
      expect(responsesUserContent('', [{ data: 'aGk=', mediaType }])).toEqual([
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: 'aGk=' } },
      ]);
    },
  );

  it.each(['image/svg+xml', 'text/plain', 'image/jpg', ''])(
    'rejects unsupported MIME %s',
    (mediaType) => {
      expect(() => responsesUserContent('', [{ data: 'aGk=', mediaType }])).toThrow(
        /unsupported image media type/i,
      );
    },
  );

  it.each([
    '',
    ' ',
    'aGk',
    'aGk===',
    'a Gk=',
    'aGk=\n',
    'aGk_',
    'Zh==',
    'data:image/png;base64,aGk=',
  ])('rejects empty or malformed base64 %j', (data) => {
    expect(() => responsesUserContent('', [{ data, mediaType: 'image/png' }])).toThrow(
      /valid nonempty base64/i,
    );
  });

  it('accepts the decoded size limit and rejects larger images', () => {
    const allowed = Buffer.alloc(10 * 1024 * 1024).toString('base64');
    expect(responsesUserContent('', [{ data: allowed, mediaType: 'image/png' }])).toHaveLength(1);
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    expect(() => responsesUserContent('', [{ data: oversized, mediaType: 'image/png' }])).toThrow(
      /10 MiB/i,
    );
  });
});
