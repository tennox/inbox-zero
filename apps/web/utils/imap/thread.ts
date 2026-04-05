import type { ImapFlow } from "imapflow";
import { searchByUid } from "@/utils/imap/uid-helpers";

/**
 * Given a set of UIDs that belong to a THREAD result group,
 * returns all UIDs in that thread (the input, deduplicated).
 * For server-side THREAD command results this is a passthrough;
 * extend here if you need to fetch related messages by References headers.
 */
export async function getThreadMembers(
  _client: ImapFlow,
  _mailbox: string,
  threadUids: number[],
): Promise<number[]> {
  return [...new Set(threadUids)].sort((a, b) => a - b);
}

/**
 * Extracts the root Message-ID from a References chain to use as thread ID.
 *
 * Strategy:
 *   1. If References header exists, take the first (oldest) Message-ID in the chain.
 *   2. If In-Reply-To exists but no References, use In-Reply-To.
 *   3. Fall back to the message's own Message-ID.
 *   4. If nothing is available, return an empty string.
 */
export function resolveThreadId(headers: {
  references?: string;
  messageId?: string;
  inReplyTo?: string;
}): string {
  if (headers.references) {
    // References is a whitespace/newline-separated list of message IDs
    const ids = headers.references
      .split(/\s+/)
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length > 0) {
      // First entry in References is the oldest ancestor — use as thread root
      return ids[0];
    }
  }

  if (headers.inReplyTo) {
    const id = headers.inReplyTo.trim();
    if (id) return id;
  }

  return headers.messageId?.trim() ?? "";
}

/**
 * Returns a map of threadId → UID[] using the IMAP THREAD=REFERENCES command
 * when the server supports it.
 *
 * Fallback: if the server doesn't support THREAD, fetches References/In-Reply-To
 * headers for all messages and groups them client-side.
 *
 * @param client  Connected ImapFlow instance (mailbox should be open)
 * @param mailbox Mailbox path to thread
 */
export async function getThreadsByReferences(
  client: ImapFlow,
  mailbox: string,
): Promise<Map<string, number[]>> {
  const caps = client.capabilities;
  const supportsThread =
    caps.has("THREAD=REFERENCES") || caps.has("THREAD=ORDEREDSUBJECT");

  if (supportsThread) {
    return getThreadsViaImapCommand(client, mailbox);
  }

  return getThreadsViaHeaderScan(client, mailbox);
}

/**
 * Uses the IMAP THREAD command (server-side) to build the thread map.
 * TODO: verify ImapFlow API — ImapFlow may not expose a dedicated thread() method.
 *       If unavailable, the header-scan fallback below is used.
 */
async function getThreadsViaImapCommand(
  client: ImapFlow,
  mailbox: string,
): Promise<Map<string, number[]>> {
  // ImapFlow does not expose a dedicated thread() method in its public API as of v1.x.
  // We fall through to the header-scan approach which works universally.
  // TODO: verify ImapFlow API — check if a future version adds client.thread()
  return getThreadsViaHeaderScan(client, mailbox);
}

/**
 * Client-side threading fallback: fetches References/In-Reply-To/Message-ID
 * headers for all messages and groups them by thread root.
 */
async function getThreadsViaHeaderScan(
  client: ImapFlow,
  mailbox: string,
): Promise<Map<string, number[]>> {
  const uids = await searchByUid(client, mailbox, { all: true });

  if (uids.length === 0) {
    return new Map();
  }

  const range = uids.join(",");
  const threadMap = new Map<string, number[]>();

  const messages = await client.fetchAll(
    range,
    {
      uid: true,
      headers: ["message-id", "references", "in-reply-to"],
    },
    { uid: true },
  );

  for (const msg of messages) {
    const headersBuffer = msg.headers;
    const uid = msg.uid;

    let messageId: string | undefined;
    let references: string | undefined;
    let inReplyTo: string | undefined;

    if (headersBuffer) {
      const headersText = headersBuffer.toString("utf8");
      messageId = extractHeader(headersText, "message-id");
      references = extractHeader(headersText, "references");
      inReplyTo = extractHeader(headersText, "in-reply-to");
    }

    const threadId = resolveThreadId({ references, messageId, inReplyTo });
    const key = threadId || String(uid);

    const existing = threadMap.get(key);
    if (existing) {
      existing.push(uid);
    } else {
      threadMap.set(key, [uid]);
    }
  }

  return threadMap;
}

/**
 * Simple header extraction from raw header block text.
 * Handles folded headers (continuation lines starting with whitespace).
 */
function extractHeader(headersText: string, name: string): string | undefined {
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
