/** Render only the frozen review bytes, never a newly fetched artifact version. */
export function ReviewedArtifactContents({
  revision,
  contentBase64,
}: {
  revision: number;
  contentBase64?: string;
}) {
  if (contentBase64 === undefined)
    return <p>This historical snapshot contains a reference only, without saved contents.</p>;

  let text: string;
  let encoded = false;
  try {
    const bytes = Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0));
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    // Binary/invalid UTF-8 and malformed historical base64 remain inspectable
    // without replacement characters or silently omitted review material.
    if (
      typeof cause !== 'object' ||
      cause === null ||
      !('name' in cause) ||
      !['TypeError', 'InvalidCharacterError'].includes(String(cause.name))
    )
      throw cause;
    text = contentBase64;
    encoded = true;
  }
  // Non-printing binary control bytes must not disappear in a text preview.
  if (
    [...text].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  ) {
    text = contentBase64;
    encoded = true;
  }
  return (
    <div className="conversation-joining-message">
      {encoded && <small>Encoded contents (Base64)</small>}
      <p aria-label={`Saved contents, version ${revision}`}>{text}</p>
    </div>
  );
}
