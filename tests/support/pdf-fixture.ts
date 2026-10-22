/** Synthetic two-page PDF: selectable text/vector art followed by a scanned image. */
export function pdfFixture(): Buffer {
  const stream = (data: string, extra = '') =>
    `<< ${extra} /Length ${Buffer.byteLength(data)} >>\nstream\n${data}\nendstream`;
  const pixels =
    Array.from({ length: 32 * 32 }, (_, i) => (i % 32 < 16 ? 'ff2222' : '2222ff')).join('') + '>';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    stream('BT /F1 18 Tf 20 350 Td (PDF import sample) Tj ET 1 0 0 rg 20 60 200 60 re f'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /XObject << /Im0 8 0 R >> >> /Contents 6 0 R >>',
    stream('q 300 0 0 400 0 0 cm /Im0 Do Q'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(
      pixels,
      '/Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode',
    ),
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(content);
}
