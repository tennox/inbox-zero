/**
 * Maps between IMAP flags/keywords and Inbox Zero label IDs.
 *
 * IMAP system flags start with `\` (backslash).
 * Inbox Zero custom keywords use the `$iz_` prefix.
 *
 * Label ID conventions used in this module:
 *   "STARRED"  — \Flagged
 *   "DRAFT"    — \Draft
 *   "SENT"     — \Sent  (not standard but used by some servers)
 *   "$iz_*"    — custom Inbox Zero labels stored in DB
 */

const INBOX_ZERO_KEYWORD_PREFIX = "$iz_";

/**
 * Maps IMAP flags and keywords to Inbox Zero label IDs.
 *
 * Note: \Seen is intentionally NOT mapped to a label — read/unread status
 * is tracked separately and does not produce a label ID.
 */
export function imapFlagsToLabelIds(flags: string[]): string[] {
  const labelIds: string[] = [];

  for (const flag of flags) {
    switch (flag.toLowerCase()) {
      case "\\flagged":
        labelIds.push("STARRED");
        break;

      case "\\draft":
        labelIds.push("DRAFT");
        break;

      case "\\seen":
        // Read/unread is tracked separately; not mapped to a label ID
        break;

      case "\\answered":
        // Not mapped to a visible label
        break;

      case "\\deleted":
        // Deleted messages are typically not returned; skip
        break;

      default:
        // Custom Inbox Zero keywords
        if (isInboxZeroKeyword(flag)) {
          labelIds.push(imapKeywordToLabelId(flag));
        }
        break;
    }
  }

  return labelIds;
}

/**
 * Converts an Inbox Zero label ID to an IMAP keyword.
 * Prefixes with "$iz_" for namespacing on the server.
 *
 * Examples:
 *   "newsletter"       → "$iz_newsletter"
 *   "$iz_newsletter"   → "$iz_newsletter"  (idempotent)
 */
export function labelIdToImapKeyword(labelId: string): string {
  if (labelId.startsWith(INBOX_ZERO_KEYWORD_PREFIX)) {
    return labelId;
  }
  // Sanitise: IMAP keywords must not contain spaces or certain special chars.
  // Replace spaces with underscores and strip characters outside the allowed set.
  const sanitised = labelId
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-.]/g, "");
  return `${INBOX_ZERO_KEYWORD_PREFIX}${sanitised}`;
}

/**
 * Returns true if the flag is an Inbox Zero managed keyword.
 */
export function isInboxZeroKeyword(flag: string): boolean {
  return flag.startsWith(INBOX_ZERO_KEYWORD_PREFIX);
}

/**
 * Converts an IMAP keyword that uses the $iz_ prefix back to a label ID.
 * Strips the prefix.
 *
 * Example: "$iz_newsletter" → "newsletter"
 */
function imapKeywordToLabelId(keyword: string): string {
  return keyword.slice(INBOX_ZERO_KEYWORD_PREFIX.length);
}
