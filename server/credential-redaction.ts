function normalizedJsonNumber(value: string): string | undefined {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return undefined;
  const fraction = match[3] ?? '';
  const digits = `${match[2]}${fraction}`.replace(/^0+/, '');
  if (!digits) return '0';
  const coefficient = digits.replace(/0+$/, '');
  // Compare exact decimal values without floating-point rounding or overflow.
  const exponent =
    BigInt(match[4] ?? '0') - BigInt(fraction.length) + BigInt(digits.length - coefficient.length);
  return `${match[1]}${coefficient}e${exponent}`;
}

export function redactCredentialResponse(
  responseBody: string,
  secret: string,
  headers: Record<string, string>,
): string {
  const values = [
    ...new Set([
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      ...Object.values(headers).flatMap((value) => [value, value.replace(/^(Basic|Bearer) /, '')]),
    ]),
  ].sort((a, b) => b.length - a.length);
  const redact = (text: string) => {
    for (const value of values) text = text.split(value).join('[redacted]');
    return text;
  };
  // Decode each JSON string before redacting: quote/backslash, Unicode and
  // slash escapes can otherwise hide echoed secrets in both keys and values.
  const decoded = responseBody.replace(
    // eslint-disable-next-line no-control-regex -- JSON strings exclude unescaped control characters.
    /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/g,
    (token) => {
      const text = JSON.parse(token) as string;
      const safe = redact(text);
      return safe === text ? token : JSON.stringify(safe);
    },
  );
  let body: string;
  try {
    // In valid JSON, punctuation is structural rather than an echoed secret
    // (for example a password consisting of a quote). Keep it intact.
    JSON.parse(responseBody);
    const numbers = new Set(
      values.map(normalizedJsonNumber).filter((value) => value !== undefined),
    );
    body = decoded.replace(
      // Match whole strings too, so their contents cannot be changed here.
      // eslint-disable-next-line no-control-regex -- JSON strings exclude unescaped control characters.
      /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
      (token) => {
        const number = normalizedJsonNumber(token);
        return (number !== undefined && numbers.has(number)) ||
          (['true', 'false', 'null'].includes(token) && values.includes(token))
          ? '"[redacted]"'
          : token;
      },
    );
  } catch {
    body = redact(decoded);
  }
  return body;
}
