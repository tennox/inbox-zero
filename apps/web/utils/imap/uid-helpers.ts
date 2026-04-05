import type { ImapFlow, FetchQueryObject, SearchObject } from "imapflow";

/**
 * Ensures the given mailbox is open. If a different mailbox is currently open,
 * closes it and opens the requested one.
 */
async function ensureMailboxOpen(
  client: ImapFlow,
  mailbox: string,
): Promise<void> {
  const current = client.mailbox;
  // client.mailbox is false when no mailbox is open, or a MailboxObject when one is open
  if (!current || (current as { path: string }).path !== mailbox) {
    await client.mailboxOpen(mailbox);
  }
}

/**
 * Fetches messages by UID range from the specified mailbox.
 * Always uses UID mode — never sequence numbers.
 *
 * @param client  Connected ImapFlow instance
 * @param mailbox Mailbox path (e.g. "INBOX")
 * @param range   UID range string (e.g. "1:*", "100:200", "42")
 * @param query   Fields to include in the fetch response
 * @returns       AsyncIterableIterator of FetchMessageObject
 */
export async function fetchByUid(
  client: ImapFlow,
  mailbox: string,
  range: string,
  query: FetchQueryObject,
): Promise<ReturnType<ImapFlow["fetch"]>> {
  await ensureMailboxOpen(client, mailbox);
  return client.fetch(range, query, { uid: true });
}

/**
 * Searches a mailbox and returns an array of UIDs matching the criteria.
 * Always uses UID mode.
 */
export async function searchByUid(
  client: ImapFlow,
  mailbox: string,
  criteria: SearchObject,
): Promise<number[]> {
  await ensureMailboxOpen(client, mailbox);
  const result = await client.search(criteria, { uid: true });
  // client.search returns number[] | false
  return result || [];
}

/**
 * Sets or clears flags on messages identified by UID range.
 * Uses messageFlagsSet; caller is responsible for add vs. set semantics.
 *
 * @param flags Object with `set`, `add`, or `remove` arrays of flag strings
 */
export async function storeByUid(
  client: ImapFlow,
  mailbox: string,
  range: string,
  flags: { set?: string[]; add?: string[]; remove?: string[] },
): Promise<void> {
  await ensureMailboxOpen(client, mailbox);

  if (flags.set?.length) {
    await client.messageFlagsSet(range, flags.set, { uid: true });
  }
  if (flags.add?.length) {
    await client.messageFlagsAdd(range, flags.add, { uid: true });
  }
  if (flags.remove?.length) {
    await client.messageFlagsRemove(range, flags.remove, { uid: true });
  }
}

/**
 * Moves messages identified by UID range from mailbox to destination.
 * Requires the server to support the MOVE extension; falls back to copy+delete.
 */
export async function moveByUid(
  client: ImapFlow,
  mailbox: string,
  range: string,
  destination: string,
): Promise<void> {
  await ensureMailboxOpen(client, mailbox);
  // ImapFlow's messageMove handles the MOVE command (or copy+expunge fallback)
  // TODO: verify ImapFlow API — messageMove may fall back internally already
  await client.messageMove(range, destination, { uid: true });
}

/**
 * Copies messages identified by UID range from mailbox to destination.
 */
export async function copyByUid(
  client: ImapFlow,
  mailbox: string,
  range: string,
  destination: string,
): Promise<void> {
  await ensureMailboxOpen(client, mailbox);
  await client.messageCopy(range, destination, { uid: true });
}
