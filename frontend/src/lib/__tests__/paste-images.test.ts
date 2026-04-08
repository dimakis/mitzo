import { describe, it, expect } from 'vitest';
import { extractImageFiles } from '../paste-images';

function makeItem(type: string, file: File | null): DataTransferItem {
  return {
    kind: file ? 'file' : 'string',
    type,
    getAsFile: () => file,
    getAsString: (_callback: FunctionStringCallback) => {},
    webkitGetAsEntry: () => null,
  } as unknown as DataTransferItem;
}

function makeFile(name: string, type: string): File {
  return new File(['fake-data'], name, { type });
}

describe('extractImageFiles', () => {
  it('extracts image files from DataTransferItemList', () => {
    const file = makeFile('screenshot.png', 'image/png');
    const items = [makeItem('image/png', file)] as unknown as DataTransferItemList;

    const result = extractImageFiles(items);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('screenshot.png');
  });

  it('ignores non-image items', () => {
    const items = [
      makeItem('text/plain', null),
      makeItem('text/html', null),
    ] as unknown as DataTransferItemList;

    expect(extractImageFiles(items)).toHaveLength(0);
  });

  it('ignores items where getAsFile returns null', () => {
    const items = [makeItem('image/png', null)] as unknown as DataTransferItemList;

    expect(extractImageFiles(items)).toHaveLength(0);
  });

  it('extracts only images from mixed clipboard payload', () => {
    const file1 = makeFile('photo.png', 'image/png');
    const file2 = makeFile('diagram.jpg', 'image/jpeg');
    const items = [
      makeItem('text/plain', null),
      makeItem('image/png', file1),
      makeItem('text/html', null),
      makeItem('image/jpeg', file2),
      makeItem('application/pdf', null),
    ] as unknown as DataTransferItemList;

    const result = extractImageFiles(items);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('photo.png');
    expect(result[1].name).toBe('diagram.jpg');
  });

  it('extracts multiple images', () => {
    const file1 = makeFile('a.png', 'image/png');
    const file2 = makeFile('b.jpg', 'image/jpeg');
    const items = [
      makeItem('image/png', file1),
      makeItem('image/jpeg', file2),
    ] as unknown as DataTransferItemList;

    const result = extractImageFiles(items);
    expect(result).toHaveLength(2);
  });

  it('respects the maxCount parameter and keeps the first N items', () => {
    const file1 = makeFile('a.png', 'image/png');
    const file2 = makeFile('b.png', 'image/png');
    const file3 = makeFile('c.png', 'image/png');
    const items = [
      makeItem('image/png', file1),
      makeItem('image/png', file2),
      makeItem('image/png', file3),
    ] as unknown as DataTransferItemList;

    const result = extractImageFiles(items, 2);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('a.png');
    expect(result[1].name).toBe('b.png');
  });
});
