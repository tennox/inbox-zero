/**
 * Extracts a single header value from raw IMAP header block text.
 * Handles folded (multi-line) headers per RFC 5322.
 */
export function extractHeader(
  headersText: string,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  const lines = headersText.split(/\r?\n/);

  let value: string | undefined;
  let capturing = false;

  for (const line of lines) {
    if (capturing) {
      // Folded header continuation
      if (/^\s/.test(line)) {
        value = `${value ?? ""} ${line.trim()}`;
        continue;
      }
      // New header starts — stop capturing
      capturing = false;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const headerName = line.slice(0, colonIdx).toLowerCase().trim();
    if (headerName === lowerName) {
      value = line.slice(colonIdx + 1).trim();
      capturing = true;
    }
  }

  return value;
}
