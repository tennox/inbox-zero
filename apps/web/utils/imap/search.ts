import type { SearchObject } from "imapflow";

/**
 * Translates an Inbox Zero query string into an ImapFlow SearchObject.
 *
 * Supported query tokens:
 *   from:addr        → { from: "addr" }
 *   to:addr          → { to: "addr" }
 *   subject:text     → { subject: "text" }
 *   before:YYYY-MM-DD → { before: Date }
 *   after:YYYY-MM-DD  → { sentSince: Date }  (maps to IMAP SENTSINCE)
 *   is:read          → { seen: true }
 *   is:unread        → { seen: false }
 *   is:starred       → { flagged: true }
 *   is:draft         → { draft: true }
 *   has:attachment   → not directly searchable; returns { all: true } with a note
 *   <bare text>      → { text: "..." }
 *
 * Multiple tokens are ANDed together (all conditions must match).
 */
export function translateQuery(query: string | undefined): SearchObject {
  if (!query || query.trim() === "") {
    return { all: true };
  }

  const criteria: SearchObject = {};
  const remaining: string[] = [];

  // Tokenise preserving quoted strings
  const tokens = tokenise(query);

  for (const token of tokens) {
    const colonIdx = token.indexOf(":");
    if (colonIdx === -1) {
      remaining.push(token);
      continue;
    }

    const field = token.slice(0, colonIdx).toLowerCase();
    const value = token
      .slice(colonIdx + 1)
      .replace(/^["']|["']$/g, "")
      .trim();

    switch (field) {
      case "from":
        criteria.from = value;
        break;

      case "to":
        criteria.to = value;
        break;

      case "cc":
        criteria.cc = value;
        break;

      case "subject":
        criteria.subject = value;
        break;

      case "before": {
        const d = parseDate(value);
        if (d) criteria.before = d;
        break;
      }

      case "after": {
        const d = parseDate(value);
        // IMAP SEARCH SENTSINCE matches messages whose [RFC-2822] Date: is within or later than the specified day
        if (d) criteria.sentSince = d;
        break;
      }

      case "since": {
        const d = parseDate(value);
        if (d) criteria.since = d;
        break;
      }

      case "is":
        switch (value.toLowerCase()) {
          case "read":
            criteria.seen = true;
            break;
          case "unread":
            criteria.seen = false;
            break;
          case "starred":
          case "flagged":
            criteria.flagged = true;
            break;
          case "draft":
            criteria.draft = true;
            break;
          case "answered":
            criteria.answered = true;
            break;
        }
        break;

      case "has":
        if (value.toLowerCase() === "attachment") {
          // IMAP SEARCH does not universally support attachment detection.
          // The caller must post-filter results or use a server extension.
          // We return all messages and document that filtering is client-side.
          // TODO: verify if target servers (Posteo/Migadu) support SEARCH with attachment criteria
          criteria.all = true;
        }
        break;

      case "label":
      case "keyword":
        // Map to IMAP keyword search
        criteria.keyword = value;
        break;

      default:
        // Unknown field prefix — treat as text search
        remaining.push(token);
        break;
    }
  }

  // Any remaining bare text becomes a full-text search
  if (remaining.length > 0) {
    const text = remaining.join(" ").trim();
    if (text) {
      criteria.text = text;
    }
  }

  // Ensure we always have at least one criterion
  if (Object.keys(criteria).length === 0) {
    criteria.all = true;
  }

  return criteria;
}

/**
 * Parses a date string in YYYY-MM-DD or common human formats.
 * Returns undefined if unparseable.
 */
function parseDate(value: string): Date | undefined {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

/**
 * Splits a query string into tokens, respecting quoted strings.
 * e.g. `from:foo subject:"hello world"` → ["from:foo", `subject:"hello world"`]
 */
function tokenise(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (const ch of query) {
    if (inQuote) {
      current += ch;
      if (ch === quoteChar) {
        inQuote = false;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      current += ch;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
