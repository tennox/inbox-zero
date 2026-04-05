import type { ImapFlow, SearchObject } from "imapflow";
import type { Attachment as MailAttachment } from "nodemailer/lib/mailer";
import type {
  EmailProvider,
  EmailThread,
  EmailLabel,
  EmailFilter,
  EmailSignature,
  EmailFolder,
} from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import type { InboxZeroLabel } from "@/utils/label";
import { inboxZeroLabels, getLabelColor } from "@/utils/label";
import type { ThreadsQuery } from "@/app/api/threads/validation";
import type { Logger } from "@/utils/logger";
import { createScopedLogger } from "@/utils/logger";
import { fetchAndParseMessage } from "@/utils/imap/message";
import { resolveThreadId, getThreadsByReferences } from "@/utils/imap/thread";
import {
  getSpecialUseFolders,
  listFolders,
  ensureFolderExists,
  type SpecialFolders,
} from "@/utils/imap/folder";
import { translateQuery } from "@/utils/imap/search";
import { labelIdToImapKeyword } from "@/utils/imap/flags";
import { searchByUid, storeByUid, moveByUid } from "@/utils/imap/uid-helpers";
import { createSmtpTransport } from "@/utils/imap/client";
import { extractHeader } from "@/utils/imap/headers";
import { env } from "@/env";

export class ImapProvider implements EmailProvider {
  readonly name = "imap" as const;

  private readonly client: ImapFlow;
  private readonly logger: Logger;
  private readonly emailAccountId?: string;
  private specialFoldersCache: SpecialFolders | null = null;

  constructor(client: ImapFlow, logger?: Logger, emailAccountId?: string) {
    this.client = client;
    this.emailAccountId = emailAccountId;
    this.logger = (logger ?? createScopedLogger("imap-provider")).with({
      provider: "imap",
    });
  }

  toJSON() {
    return { name: this.name, type: "imap" };
  }

  getAccessToken(): string {
    return "";
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getSpecialFolders(): Promise<SpecialFolders> {
    if (!this.specialFoldersCache) {
      this.specialFoldersCache = await getSpecialUseFolders(this.client);
    }
    return this.specialFoldersCache;
  }

  /**
   * Finds all UIDs for messages belonging to the given thread across
   * INBOX (and optionally Sent). Thread ID is the root Message-ID.
   *
   * Strategy:
   *  1. SEARCH HEADER Message-ID <threadId> (exact root message)
   *  2. SEARCH HEADER References <threadId> (all replies referencing the root)
   * We union the results from INBOX and Sent folders.
   */
  private async getThreadUids(
    threadId: string,
    includeSent = true,
  ): Promise<{ mailbox: string; uids: number[] }[]> {
    const sf = await this.getSpecialFolders();
    const mailboxes = [sf.inbox];
    if (includeSent && sf.sent) mailboxes.push(sf.sent);

    const results: { mailbox: string; uids: number[] }[] = [];

    for (const mailbox of mailboxes) {
      // Search for the root message itself
      const rootUids = await searchByUid(this.client, mailbox, {
        header: { "Message-ID": threadId },
      });
      // Search for all messages that reference this thread root
      const replyUids = await searchByUid(this.client, mailbox, {
        header: { References: threadId },
      });

      const allUids = [...new Set([...rootUids, ...replyUids])].sort(
        (a, b) => a - b,
      );
      if (allUids.length > 0) {
        results.push({ mailbox, uids: allUids });
      }
    }

    return results;
  }

  private async fetchMessages(
    mailbox: string,
    uids: number[],
  ): Promise<ParsedMessage[]> {
    const messages: ParsedMessage[] = [];
    for (const uid of uids) {
      try {
        const msg = await fetchAndParseMessage(
          this.client,
          mailbox,
          uid,
          this.logger,
        );
        messages.push(msg);
      } catch (err) {
        this.logger.warn("Failed to fetch message", { uid, mailbox, err });
      }
    }
    return messages;
  }

  private uidRangeFromUids(uids: number[]): string {
    return uids.join(",");
  }

  // ---------------------------------------------------------------------------
  // Message reading
  // ---------------------------------------------------------------------------

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const sf = await this.getSpecialFolders();
    const uid = Number(messageId);
    // Try INBOX first, then Sent
    for (const mailbox of [sf.inbox, sf.sent].filter(Boolean) as string[]) {
      try {
        return await fetchAndParseMessage(
          this.client,
          mailbox,
          uid,
          this.logger,
        );
      } catch {
        // Try next mailbox
      }
    }
    // Final fallback: INBOX (will throw with a proper error)
    return fetchAndParseMessage(this.client, sf.inbox, uid, this.logger);
  }

  async getMessagesBatch(messageIds: string[]): Promise<ParsedMessage[]> {
    const results: ParsedMessage[] = [];
    for (const id of messageIds) {
      try {
        results.push(await this.getMessage(id));
      } catch (err) {
        this.logger.warn("getMessagesBatch: failed to fetch message", {
          id,
          err,
        });
      }
    }
    return results;
  }

  async getMessageByRfc822MessageId(
    rfc822MessageId: string,
  ): Promise<ParsedMessage | null> {
    const sf = await this.getSpecialFolders();
    const mailboxes = [sf.inbox, sf.sent].filter(Boolean) as string[];

    for (const mailbox of mailboxes) {
      const uids = await searchByUid(this.client, mailbox, {
        header: { "Message-ID": rfc822MessageId },
      });
      if (uids.length > 0) {
        try {
          return await fetchAndParseMessage(
            this.client,
            mailbox,
            uids[0],
            this.logger,
          );
        } catch (err) {
          this.logger.warn("getMessageByRfc822MessageId: fetch failed", {
            rfc822MessageId,
            err,
          });
        }
      }
    }

    return null;
  }

  async getOriginalMessage(
    originalMessageId: string | undefined,
  ): Promise<ParsedMessage | null> {
    if (!originalMessageId) return null;
    try {
      return await this.getMessage(originalMessageId);
    } catch {
      return null;
    }
  }

  async getPreviousConversationMessages(
    messageIds: string[],
  ): Promise<ParsedMessage[]> {
    return this.getMessagesBatch(messageIds);
  }

  // ---------------------------------------------------------------------------
  // Thread reading
  // ---------------------------------------------------------------------------

  async getThread(threadId: string): Promise<EmailThread> {
    const messages = await this.getThreadMessages(threadId);
    const snippet = messages[0]?.snippet ?? "";
    return {
      id: threadId,
      messages,
      snippet,
    };
  }

  async getThreadMessages(threadId: string): Promise<ParsedMessage[]> {
    const groups = await this.getThreadUids(threadId);
    const all: ParsedMessage[] = [];
    for (const { mailbox, uids } of groups) {
      const msgs = await this.fetchMessages(mailbox, uids);
      all.push(...msgs);
    }
    // Sort by date ascending
    all.sort(
      (a, b) =>
        new Date(a.internalDate ?? a.date).getTime() -
        new Date(b.internalDate ?? b.date).getTime(),
    );
    return all;
  }

  async getThreadMessagesInInbox(threadId: string): Promise<ParsedMessage[]> {
    const sf = await this.getSpecialFolders();
    const rootUids = await searchByUid(this.client, sf.inbox, {
      header: { "Message-ID": threadId },
    });
    const replyUids = await searchByUid(this.client, sf.inbox, {
      header: { References: threadId },
    });
    const uids = [...new Set([...rootUids, ...replyUids])].sort(
      (a, b) => a - b,
    );
    return this.fetchMessages(sf.inbox, uids);
  }

  async getLatestMessageInThread(
    threadId: string,
  ): Promise<ParsedMessage | null> {
    const messages = await this.getThreadMessages(threadId);
    if (messages.length === 0) return null;
    return messages[messages.length - 1];
  }

  async getLatestMessageFromThreadSnapshot(
    thread: Pick<EmailThread, "id" | "messages">,
  ): Promise<ParsedMessage | null> {
    if (thread.messages.length === 0) return null;
    return thread.messages[thread.messages.length - 1];
  }

  async getThreads(folderId?: string): Promise<EmailThread[]> {
    const sf = await this.getSpecialFolders();
    const mailbox = folderId ?? sf.inbox;

    const threadMap = await getThreadsByReferences(this.client, mailbox);
    const threads: EmailThread[] = [];

    for (const [threadId, uids] of threadMap.entries()) {
      const messages = await this.fetchMessages(mailbox, uids);
      threads.push({
        id: threadId,
        messages,
        snippet: messages[0]?.snippet ?? "",
      });
    }

    return threads;
  }

  async getThreadsWithQuery(options: {
    query?: ThreadsQuery;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    const { query, maxResults = 50, pageToken } = options;
    const sf = await this.getSpecialFolders();
    const mailbox = sf.inbox;

    const queryStr = buildQueryString(query);
    const criteria = translateQuery(queryStr);

    let uids = await searchByUid(this.client, mailbox, criteria);

    // Pagination by UID offset (pageToken is a UID string)
    const offsetUid = pageToken ? Number(pageToken) : 0;
    if (offsetUid > 0) {
      uids = uids.filter((uid) => uid < offsetUid);
    }

    // Sort descending, take maxResults
    uids.sort((a, b) => b - a);
    const pageUids = uids.slice(0, maxResults);
    const nextPageToken =
      uids.length > maxResults ? String(uids[maxResults]) : undefined;

    // Group into threads by fetching headers
    const threadMap = new Map<string, number[]>();
    for (const uid of pageUids) {
      try {
        const headers = await fetchMessageHeadersRaw(this.client, mailbox, uid);
        const threadId = resolveThreadId({
          references: headers.references,
          messageId: headers.messageId,
          inReplyTo: headers.inReplyTo,
        });
        const key = threadId || String(uid);
        const existing = threadMap.get(key);
        if (existing) {
          existing.push(uid);
        } else {
          threadMap.set(key, [uid]);
        }
      } catch {
        threadMap.set(String(uid), [uid]);
      }
    }

    const threads: EmailThread[] = [];
    for (const [threadId, threadUids] of threadMap.entries()) {
      const messages = await this.fetchMessages(mailbox, threadUids);
      threads.push({
        id: threadId,
        messages,
        snippet: messages[0]?.snippet ?? "",
      });
    }

    return { threads, nextPageToken };
  }

  async getThreadsWithLabel(options: {
    labelId: string;
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const { labelId, maxResults = 50 } = options;
    const sf = await this.getSpecialFolders();
    const keyword = labelIdToImapKeyword(labelId);

    let uids = await searchByUid(this.client, sf.inbox, {
      keyword,
    });
    uids = uids.slice(0, maxResults);

    const threadMap = new Map<string, number[]>();
    for (const uid of uids) {
      try {
        const headers = await fetchMessageHeadersRaw(
          this.client,
          sf.inbox,
          uid,
        );
        const threadId = resolveThreadId({
          references: headers.references,
          messageId: headers.messageId,
          inReplyTo: headers.inReplyTo,
        });
        const key = threadId || String(uid);
        const existing = threadMap.get(key);
        if (existing) {
          existing.push(uid);
        } else {
          threadMap.set(key, [uid]);
        }
      } catch {
        threadMap.set(String(uid), [uid]);
      }
    }

    const threads: EmailThread[] = [];
    for (const [threadId, threadUids] of threadMap.entries()) {
      const messages = await this.fetchMessages(sf.inbox, threadUids);
      threads.push({
        id: threadId,
        messages,
        snippet: messages[0]?.snippet ?? "",
      });
    }

    return threads;
  }

  async getThreadsFromSenderWithSubject(
    sender: string,
    limit: number,
  ): Promise<Array<{ id: string; snippet: string; subject: string }>> {
    const sf = await this.getSpecialFolders();
    let uids = await searchByUid(this.client, sf.inbox, { from: sender });
    uids = uids.slice(-limit); // latest `limit` messages

    const results: Array<{ id: string; snippet: string; subject: string }> = [];
    const seenThreads = new Set<string>();

    for (const uid of uids) {
      try {
        const msg = await fetchAndParseMessage(
          this.client,
          sf.inbox,
          uid,
          this.logger,
        );
        if (!seenThreads.has(msg.threadId)) {
          seenThreads.add(msg.threadId);
          results.push({
            id: msg.threadId,
            snippet: msg.snippet,
            subject: msg.subject,
          });
        }
      } catch {
        // skip
      }
    }

    return results;
  }

  async getThreadsWithParticipant(options: {
    participantEmail: string;
    maxThreads?: number;
  }): Promise<EmailThread[]> {
    const { participantEmail, maxThreads = 50 } = options;
    const sf = await this.getSpecialFolders();

    // Search in both FROM and TO
    const fromUids = await searchByUid(this.client, sf.inbox, {
      from: participantEmail,
    });
    const toUids = await searchByUid(this.client, sf.inbox, {
      to: participantEmail,
    });
    const allUids = [...new Set([...fromUids, ...toUids])];
    allUids.sort((a, b) => b - a);
    const limited = allUids.slice(0, maxThreads);

    const threadMap = new Map<string, number[]>();
    for (const uid of limited) {
      try {
        const headers = await fetchMessageHeadersRaw(
          this.client,
          sf.inbox,
          uid,
        );
        const threadId = resolveThreadId({
          references: headers.references,
          messageId: headers.messageId,
          inReplyTo: headers.inReplyTo,
        });
        const key = threadId || String(uid);
        const existing = threadMap.get(key);
        if (existing) {
          existing.push(uid);
        } else {
          threadMap.set(key, [uid]);
        }
      } catch {
        threadMap.set(String(uid), [uid]);
      }
    }

    const threads: EmailThread[] = [];
    for (const [threadId, threadUids] of threadMap.entries()) {
      const messages = await this.fetchMessages(sf.inbox, threadUids);
      threads.push({
        id: threadId,
        messages,
        snippet: messages[0]?.snippet ?? "",
      });
    }

    return threads;
  }

  async getSentThreadsExcluding(options: {
    excludeToEmails?: string[];
    excludeFromEmails?: string[];
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const {
      excludeToEmails = [],
      excludeFromEmails = [],
      maxResults = 100,
    } = options;
    const sf = await this.getSpecialFolders();
    if (!sf.sent) return [];

    const uids = await searchByUid(this.client, sf.sent, { all: true });
    uids.sort((a, b) => b - a);

    const threads: EmailThread[] = [];
    const seenThreadIds = new Set<string>();

    for (const uid of uids) {
      if (threads.length >= maxResults) break;
      try {
        const msg = await fetchAndParseMessage(
          this.client,
          sf.sent,
          uid,
          this.logger,
        );

        // Exclusion check
        const toAddr = msg.headers.to?.toLowerCase() ?? "";
        const fromAddr = msg.headers.from?.toLowerCase() ?? "";

        const excluded =
          excludeToEmails.some((e) => toAddr.includes(e.toLowerCase())) ||
          excludeFromEmails.some((e) => fromAddr.includes(e.toLowerCase()));

        if (!excluded && !seenThreadIds.has(msg.threadId)) {
          seenThreadIds.add(msg.threadId);
          threads.push({
            id: msg.threadId,
            messages: [msg],
            snippet: msg.snippet,
          });
        }
      } catch {
        // skip
      }
    }

    return threads;
  }

  async getSentMessageIds(options: {
    maxResults: number;
    after?: Date;
    before?: Date;
  }): Promise<{ id: string; threadId: string }[]> {
    const { maxResults, after, before } = options;
    const sf = await this.getSpecialFolders();
    if (!sf.sent) return [];

    const criteria: SearchObject = { all: true };
    if (after) criteria.sentSince = after;
    if (before) criteria.before = before;

    let uids = await searchByUid(this.client, sf.sent, criteria);
    uids.sort((a, b) => b - a);
    uids = uids.slice(0, maxResults);

    const results: { id: string; threadId: string }[] = [];
    for (const uid of uids) {
      try {
        const headers = await fetchMessageHeadersRaw(this.client, sf.sent, uid);
        const threadId = resolveThreadId({
          references: headers.references,
          messageId: headers.messageId,
          inReplyTo: headers.inReplyTo,
        });
        results.push({ id: String(uid), threadId: threadId || String(uid) });
      } catch {
        results.push({ id: String(uid), threadId: String(uid) });
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Message listing
  // ---------------------------------------------------------------------------

  async getMessagesWithPagination(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
    inboxOnly?: boolean;
    unreadOnly?: boolean;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const {
      query,
      maxResults = 50,
      pageToken,
      before,
      after,
      inboxOnly = false,
      unreadOnly = false,
    } = options;

    const sf = await this.getSpecialFolders();
    const mailbox = sf.inbox; // All pagination currently searches inbox

    const criteria = translateQuery(query);
    if (before) criteria.before = before;
    if (after) criteria.sentSince = after;
    if (unreadOnly) criteria.seen = false;

    let uids = await searchByUid(this.client, mailbox, criteria);
    uids.sort((a, b) => b - a);

    const offsetUid = pageToken ? Number(pageToken) : 0;
    if (offsetUid > 0) {
      uids = uids.filter((uid) => uid < offsetUid);
    }

    const pageUids = uids.slice(0, maxResults);
    const nextPageToken =
      uids.length > maxResults ? String(uids[maxResults]) : undefined;

    const messages = await this.fetchMessages(mailbox, pageUids);
    return { messages, nextPageToken };
  }

  async getMessagesFromSender(options: {
    senderEmail: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const { senderEmail, maxResults = 50, pageToken, before, after } = options;
    const sf = await this.getSpecialFolders();

    const criteria: SearchObject = { from: senderEmail };
    if (before) criteria.before = before;
    if (after) criteria.sentSince = after;

    let uids = await searchByUid(this.client, sf.inbox, criteria);
    uids.sort((a, b) => b - a);

    const offsetUid = pageToken ? Number(pageToken) : 0;
    if (offsetUid > 0) {
      uids = uids.filter((uid) => uid < offsetUid);
    }

    const pageUids = uids.slice(0, maxResults);
    const nextPageToken =
      uids.length > maxResults ? String(uids[maxResults]) : undefined;

    const messages = await this.fetchMessages(sf.inbox, pageUids);
    return { messages, nextPageToken };
  }

  async getInboxMessages(maxResults = 20): Promise<ParsedMessage[]> {
    const sf = await this.getSpecialFolders();
    let uids = await searchByUid(this.client, sf.inbox, { all: true });
    uids.sort((a, b) => b - a);
    uids = uids.slice(0, maxResults);
    return this.fetchMessages(sf.inbox, uids);
  }

  async getSentMessages(maxResults = 20): Promise<ParsedMessage[]> {
    const sf = await this.getSpecialFolders();
    if (!sf.sent) return [];

    let uids = await searchByUid(this.client, sf.sent, { all: true });
    uids.sort((a, b) => b - a);
    uids = uids.slice(0, maxResults);
    return this.fetchMessages(sf.sent, uids);
  }

  async getMessagesWithAttachments(options: {
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const { maxResults = 50, pageToken } = options;
    const sf = await this.getSpecialFolders();

    // IMAP doesn't have a universal attachment search — fetch and filter client-side
    let uids = await searchByUid(this.client, sf.inbox, { all: true });
    uids.sort((a, b) => b - a);

    const offsetUid = pageToken ? Number(pageToken) : 0;
    if (offsetUid > 0) {
      uids = uids.filter((uid) => uid < offsetUid);
    }

    const messages: ParsedMessage[] = [];
    let lastUid: number | undefined;

    for (const uid of uids) {
      if (messages.length >= maxResults) {
        lastUid = uid;
        break;
      }
      try {
        const msg = await fetchAndParseMessage(
          this.client,
          sf.inbox,
          uid,
          this.logger,
        );
        if (msg.attachments && msg.attachments.length > 0) {
          messages.push(msg);
        }
      } catch {
        // skip
      }
    }

    return {
      messages,
      nextPageToken: lastUid !== undefined ? String(lastUid) : undefined,
    };
  }

  async getInboxStats(): Promise<{ total: number; unread: number }> {
    const sf = await this.getSpecialFolders();
    const status = await this.client.status(sf.inbox, {
      messages: true,
      unseen: true,
    });
    return {
      total: status.messages ?? 0,
      unread: status.unseen ?? 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Thread actions
  // ---------------------------------------------------------------------------

  async archiveThread(threadId: string, _ownerEmail: string): Promise<void> {
    const sf = await this.getSpecialFolders();
    const archiveFolder =
      sf.archive ?? (await ensureFolderExists(this.client, "Archive"));

    const groups = await this.getThreadUids(threadId, false);
    for (const { mailbox, uids } of groups) {
      if (uids.length === 0) continue;
      await moveByUid(
        this.client,
        mailbox,
        this.uidRangeFromUids(uids),
        archiveFolder,
      );
    }
  }

  async archiveThreadWithLabel(
    threadId: string,
    ownerEmail: string,
    labelId?: string,
  ): Promise<void> {
    await this.archiveThread(threadId, ownerEmail);

    if (labelId) {
      const sf = await this.getSpecialFolders();
      const archiveFolder =
        sf.archive ?? (await ensureFolderExists(this.client, "Archive"));
      const keyword = labelIdToImapKeyword(labelId);

      // Find just-moved UIDs in archive
      const rootUids = await searchByUid(this.client, archiveFolder, {
        header: { "Message-ID": threadId },
      });
      const replyUids = await searchByUid(this.client, archiveFolder, {
        header: { References: threadId },
      });
      const allUids = [...new Set([...rootUids, ...replyUids])];
      if (allUids.length > 0) {
        await storeByUid(
          this.client,
          archiveFolder,
          this.uidRangeFromUids(allUids),
          { add: [keyword] },
        );
      }
    }
  }

  async archiveMessage(messageId: string): Promise<void> {
    const sf = await this.getSpecialFolders();
    const archiveFolder =
      sf.archive ?? (await ensureFolderExists(this.client, "Archive"));

    await moveByUid(this.client, sf.inbox, messageId, archiveFolder);
  }

  async trashThread(
    threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ): Promise<void> {
    const sf = await this.getSpecialFolders();
    const trashFolder =
      sf.trash ?? (await ensureFolderExists(this.client, "Trash"));

    const groups = await this.getThreadUids(threadId, false);
    for (const { mailbox, uids } of groups) {
      if (uids.length === 0) continue;
      await moveByUid(
        this.client,
        mailbox,
        this.uidRangeFromUids(uids),
        trashFolder,
      );
    }
  }

  async markRead(threadId: string): Promise<void> {
    return this.markReadThread(threadId, true);
  }

  async markReadThread(threadId: string, read: boolean): Promise<void> {
    const groups = await this.getThreadUids(threadId);
    for (const { mailbox, uids } of groups) {
      if (uids.length === 0) continue;
      const range = this.uidRangeFromUids(uids);
      if (read) {
        await storeByUid(this.client, mailbox, range, { add: ["\\Seen"] });
      } else {
        await storeByUid(this.client, mailbox, range, {
          remove: ["\\Seen"],
        });
      }
    }
  }

  async markSpam(threadId: string): Promise<void> {
    const sf = await this.getSpecialFolders();
    const junkFolder =
      sf.junk ?? (await ensureFolderExists(this.client, "Junk"));

    const groups = await this.getThreadUids(threadId, false);
    for (const { mailbox, uids } of groups) {
      if (uids.length === 0) continue;
      await moveByUid(
        this.client,
        mailbox,
        this.uidRangeFromUids(uids),
        junkFolder,
      );
    }
  }

  async moveThreadToFolder(
    threadId: string,
    _ownerEmail: string,
    folderName: string,
  ): Promise<void> {
    const targetFolder = await ensureFolderExists(this.client, folderName);
    const groups = await this.getThreadUids(threadId, false);
    for (const { mailbox, uids } of groups) {
      if (uids.length === 0) continue;
      await moveByUid(
        this.client,
        mailbox,
        this.uidRangeFromUids(uids),
        targetFolder,
      );
    }
  }

  async blockUnsubscribedEmail(messageId: string): Promise<void> {
    const sf = await this.getSpecialFolders();
    const junkFolder =
      sf.junk ?? (await ensureFolderExists(this.client, "Junk"));
    await moveByUid(this.client, sf.inbox, messageId, junkFolder);
  }

  // ---------------------------------------------------------------------------
  // Label operations
  // ---------------------------------------------------------------------------

  async labelMessage(options: {
    messageId: string;
    labelId: string;
    labelName: string | null;
  }): Promise<{ usedFallback?: boolean; actualLabelId?: string }> {
    const { messageId, labelId } = options;
    const keyword = labelIdToImapKeyword(labelId);

    const sf = await this.getSpecialFolders();

    // Try INBOX first; if not found there it may be in another folder already
    try {
      await storeByUid(this.client, sf.inbox, messageId, {
        add: [keyword],
      });
      return { actualLabelId: labelId };
    } catch {
      // Message may not be in INBOX — best-effort
      this.logger.warn("labelMessage: failed to store flag", {
        messageId,
        keyword,
      });
      return { usedFallback: true, actualLabelId: labelId };
    }
  }

  async createLabel(name: string, _description?: string): Promise<EmailLabel> {
    const id = labelIdToImapKeyword(name);
    return {
      id,
      name,
      type: "user",
      color: {
        backgroundColor: getLabelColor(name),
      },
    };
  }

  async getLabels(_options?: {
    includeHidden?: boolean;
  }): Promise<EmailLabel[]> {
    // Return standard IMAP "labels" (folders mapped to labels)
    const sf = await this.getSpecialFolders();

    const standardLabels: EmailLabel[] = [
      { id: sf.inbox, name: "INBOX", type: "system" },
    ];

    if (sf.sent) {
      standardLabels.push({ id: sf.sent, name: "Sent", type: "system" });
    }
    if (sf.drafts) {
      standardLabels.push({ id: sf.drafts, name: "Drafts", type: "system" });
    }
    if (sf.trash) {
      standardLabels.push({ id: sf.trash, name: "Trash", type: "system" });
    }
    if (sf.junk) {
      standardLabels.push({ id: sf.junk, name: "Spam", type: "system" });
    }
    if (sf.archive) {
      standardLabels.push({
        id: sf.archive,
        name: "Archive",
        type: "system",
      });
    }

    return standardLabels;
  }

  async getLabelById(labelId: string): Promise<EmailLabel | null> {
    const labels = await this.getLabels({ includeHidden: true });
    return labels.find((l) => l.id === labelId) ?? null;
  }

  async getLabelByName(name: string): Promise<EmailLabel | null> {
    const labels = await this.getLabels({ includeHidden: true });
    return (
      labels.find((l) => l.name.toLowerCase() === name.toLowerCase()) ?? null
    );
  }

  async getOrCreateInboxZeroLabel(key: InboxZeroLabel): Promise<EmailLabel> {
    const labelDef = inboxZeroLabels[key];
    return this.createLabel(labelDef.name);
  }

  async removeThreadLabel(threadId: string, labelId: string): Promise<void> {
    const keyword = labelIdToImapKeyword(labelId);
    const groups = await this.getThreadUids(threadId);
    for (const { mailbox, uids } of groups) {
      if (uids.length === 0) continue;
      await storeByUid(this.client, mailbox, this.uidRangeFromUids(uids), {
        remove: [keyword],
      });
    }
  }

  async removeThreadLabels(
    threadId: string,
    labelIds: string[],
  ): Promise<void> {
    const keywords = labelIds.map(labelIdToImapKeyword);
    const groups = await this.getThreadUids(threadId);
    for (const { mailbox, uids } of groups) {
      if (uids.length === 0) continue;
      await storeByUid(this.client, mailbox, this.uidRangeFromUids(uids), {
        remove: keywords,
      });
    }
  }

  async deleteLabel(_labelId: string): Promise<void> {
    // Labels are DB-managed for IMAP; nothing to do on the server
  }

  // ---------------------------------------------------------------------------
  // Bulk operations
  // ---------------------------------------------------------------------------

  async bulkArchiveFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    const sf = await this.getSpecialFolders();
    const archiveFolder =
      sf.archive ?? (await ensureFolderExists(this.client, "Archive"));

    for (const email of fromEmails) {
      try {
        const uids = await searchByUid(this.client, sf.inbox, { from: email });
        if (uids.length === 0) continue;
        await moveByUid(
          this.client,
          sf.inbox,
          this.uidRangeFromUids(uids),
          archiveFolder,
        );
        this.logger.info("bulkArchiveFromSenders: archived", {
          email,
          count: uids.length,
        });
      } catch (err) {
        this.logger.warn("bulkArchiveFromSenders: failed for sender", {
          email,
          err,
        });
      }
    }
  }

  async bulkTrashFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    const sf = await this.getSpecialFolders();
    const trashFolder =
      sf.trash ?? (await ensureFolderExists(this.client, "Trash"));

    for (const email of fromEmails) {
      try {
        const uids = await searchByUid(this.client, sf.inbox, { from: email });
        if (uids.length === 0) continue;
        await moveByUid(
          this.client,
          sf.inbox,
          this.uidRangeFromUids(uids),
          trashFolder,
        );
        this.logger.info("bulkTrashFromSenders: trashed", {
          email,
          count: uids.length,
        });
      } catch (err) {
        this.logger.warn("bulkTrashFromSenders: failed for sender", {
          email,
          err,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async searchMessages(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const { query, maxResults = 50, pageToken } = options;
    const sf = await this.getSpecialFolders();
    const criteria = translateQuery(query);

    let uids = await searchByUid(this.client, sf.inbox, criteria);
    uids.sort((a, b) => b - a);

    const offsetUid = pageToken ? Number(pageToken) : 0;
    if (offsetUid > 0) {
      uids = uids.filter((uid) => uid < offsetUid);
    }

    const pageUids = uids.slice(0, maxResults);
    const nextPageToken =
      uids.length > maxResults ? String(uids[maxResults]) : undefined;

    const messages = await this.fetchMessages(sf.inbox, pageUids);
    return { messages, nextPageToken };
  }

  async hasPreviousCommunicationsWithSenderOrDomain(options: {
    from: string;
    date: Date;
    messageId: string;
  }): Promise<boolean> {
    const { from, date } = options;
    const sf = await this.getSpecialFolders();

    // Search for messages from this sender BEFORE the given date
    const uids = await searchByUid(this.client, sf.inbox, {
      from,
      before: date,
    });

    return uids.length > 0;
  }

  async countReceivedMessages(
    senderEmail: string,
    threshold: number,
  ): Promise<number> {
    const sf = await this.getSpecialFolders();
    const uids = await searchByUid(this.client, sf.inbox, {
      from: senderEmail,
    });

    // Return early once we've hit threshold (avoid fetching all)
    return Math.min(uids.length, threshold + 1);
  }

  async checkIfReplySent(senderEmail: string): Promise<boolean> {
    const sf = await this.getSpecialFolders();
    if (!sf.sent) return false;

    const uids = await searchByUid(this.client, sf.sent, {
      to: senderEmail,
    });

    return uids.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Folders
  // ---------------------------------------------------------------------------

  async getFolders(): Promise<EmailFolder[]> {
    return listFolders(this.client);
  }

  async getOrCreateFolderIdByName(folderName: string): Promise<string> {
    return ensureFolderExists(this.client, folderName);
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  isReplyInThread(message: ParsedMessage): boolean {
    return !!message.headers["in-reply-to"] || !!message.headers.references;
  }

  isSentMessage(message: ParsedMessage): boolean {
    if (!message.parentFolderId) return false;
    const folderLower = message.parentFolderId.toLowerCase();
    return (
      folderLower === "sent" ||
      folderLower.includes("sent") ||
      folderLower === "sent items" ||
      folderLower === "sent mail"
    );
  }

  async getSignatures(): Promise<EmailSignature[]> {
    return [];
  }

  // ---------------------------------------------------------------------------
  // SMTP: Send email
  // ---------------------------------------------------------------------------

  private assertSmtpEnabled(): void {
    if (!env.IMAP_SMTP_ENABLED) {
      throw new Error("SMTP sending is disabled (IMAP_SMTP_ENABLED=false)");
    }
  }

  async sendEmail(args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
    attachments?: MailAttachment[];
  }): Promise<void> {
    this.assertSmtpEnabled();
    if (!this.emailAccountId) {
      throw new Error("emailAccountId is required for sendEmail");
    }
    const transport = await createSmtpTransport(this.emailAccountId);
    await transport.sendMail({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      text: args.messageText,
      attachments: args.attachments,
    });
  }

  async sendEmailWithHtml(body: {
    replyToEmail?: {
      threadId: string;
      headerMessageId: string;
      references?: string;
      messageId?: string;
    };
    to: string;
    from?: string;
    cc?: string;
    bcc?: string;
    replyTo?: string;
    subject: string;
    messageHtml: string;
    attachments?: Array<{
      filename: string;
      content: string;
      contentType: string;
    }>;
  }): Promise<{ messageId: string; threadId: string }> {
    this.assertSmtpEnabled();
    if (!this.emailAccountId) {
      throw new Error("emailAccountId is required for sendEmailWithHtml");
    }
    const transport = await createSmtpTransport(this.emailAccountId);

    const headers: Record<string, string> = {};
    if (body.replyToEmail?.headerMessageId) {
      headers["In-Reply-To"] = body.replyToEmail.headerMessageId;
      headers.References =
        body.replyToEmail.references ?? body.replyToEmail.headerMessageId;
    }

    const info = await transport.sendMail({
      from: body.from,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      replyTo: body.replyTo,
      subject: body.subject,
      html: body.messageHtml,
      headers,
      attachments: body.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });

    const msgId: string = info.messageId ?? "";
    const threadId = body.replyToEmail?.threadId ?? msgId;
    return { messageId: msgId, threadId };
  }

  async replyToEmail(
    email: ParsedMessage,
    content: string,
    options?: {
      replyTo?: string;
      from?: string;
      attachments?: MailAttachment[];
    },
  ): Promise<void> {
    this.assertSmtpEnabled();
    if (!this.emailAccountId) {
      throw new Error("emailAccountId is required for replyToEmail");
    }
    const transport = await createSmtpTransport(this.emailAccountId);

    const originalMessageId = email.headers["message-id"];
    const originalReferences = email.headers.references;

    const references = originalReferences
      ? `${originalReferences} ${originalMessageId ?? ""}`.trim()
      : (originalMessageId ?? "");

    const headers: Record<string, string> = {};
    if (originalMessageId) {
      headers["In-Reply-To"] = originalMessageId;
    }
    if (references) {
      headers.References = references;
    }

    await transport.sendMail({
      from: options?.from,
      to: email.headers.from,
      replyTo: options?.replyTo,
      subject: email.subject.startsWith("Re:")
        ? email.subject
        : `Re: ${email.subject}`,
      text: content,
      headers,
      attachments: options?.attachments,
    });
  }

  async forwardEmail(
    email: ParsedMessage,
    args: { to: string; cc?: string; bcc?: string; content?: string },
  ): Promise<void> {
    this.assertSmtpEnabled();
    if (!this.emailAccountId) {
      throw new Error("emailAccountId is required for forwardEmail");
    }
    const transport = await createSmtpTransport(this.emailAccountId);

    await transport.sendMail({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: `Fwd: ${email.subject}`,
      html: args.content ?? email.textHtml,
      text: args.content ?? email.textPlain,
    });
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }> {
    // Fetch the full message and find the attachment by ID
    const msg = await this.getMessage(messageId);
    const attachment = msg.attachments?.find(
      (a) => a.attachmentId === attachmentId,
    );
    if (!attachment) {
      throw new Error(
        `Attachment ${attachmentId} not found in message ${messageId}`,
      );
    }

    // For IMAP, attachments are already parsed from the source.
    // We return the attachment metadata; actual binary data would require
    // re-fetching the source and extracting the MIME part.
    // TODO: implement binary extraction via re-parse of message source
    return { data: "", size: attachment.size };
  }

  // ---------------------------------------------------------------------------
  // Stubs: Watch/History (polling replaces push notifications for IMAP)
  // ---------------------------------------------------------------------------

  async watchEmails(): Promise<{
    expirationDate: Date;
    subscriptionId?: string;
  } | null> {
    // IMAP uses polling — no push subscription needed
    return null;
  }

  async unwatchEmails(_subscriptionId?: string): Promise<void> {
    // No-op for IMAP
  }

  async processHistory(_options: {
    emailAddress: string;
    historyId?: number;
    startHistoryId?: number;
    subscriptionId?: string;
    resourceData?: { id: string; conversationId?: string };
    logger?: Logger;
  }): Promise<void> {
    // No-op for IMAP — polling sync handles history processing
  }

  // ---------------------------------------------------------------------------
  // Stubs: Filters (IMAP has no server-side filter API)
  // ---------------------------------------------------------------------------

  async createAutoArchiveFilter(_options: {
    from: string;
    gmailLabelId?: string;
    labelName?: string;
  }): Promise<{ status: number }> {
    return { status: 200 };
  }

  async createFilter(_options: {
    from: string;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }): Promise<{ status: number }> {
    return { status: 200 };
  }

  async getFiltersList(): Promise<EmailFilter[]> {
    return [];
  }

  async deleteFilter(_id: string): Promise<{ status: number }> {
    return { status: 200 };
  }

  // ---------------------------------------------------------------------------
  // Stubs: Drafts (not supported for IMAP in MVP)
  // ---------------------------------------------------------------------------

  async draftEmail(
    _email: ParsedMessage,
    _args: {
      to?: string;
      subject?: string;
      content: string;
      cc?: string;
      bcc?: string;
      attachments?: MailAttachment[];
    },
    _userEmail: string,
    _executedRule?: { id: string; threadId: string; emailAccountId: string },
  ): Promise<{ draftId: string }> {
    throw new Error("Drafts not supported for IMAP provider");
  }

  async createDraft(_params: {
    to: string;
    subject: string;
    messageHtml: string;
    replyToMessageId?: string;
  }): Promise<{ id: string }> {
    throw new Error("Drafts not supported for IMAP provider");
  }

  async getDraft(_draftId: string): Promise<ParsedMessage | null> {
    throw new Error("Drafts not supported for IMAP provider");
  }

  async getDrafts(_options?: {
    maxResults?: number;
  }): Promise<ParsedMessage[]> {
    throw new Error("Drafts not supported for IMAP provider");
  }

  async updateDraft(
    _draftId: string,
    _params: { messageHtml?: string; subject?: string },
  ): Promise<void> {
    throw new Error("Drafts not supported for IMAP provider");
  }

  async deleteDraft(_draftId: string): Promise<void> {
    throw new Error("Drafts not supported for IMAP provider");
  }

  async sendDraft(
    _draftId: string,
  ): Promise<{ messageId: string; threadId: string }> {
    throw new Error("Drafts not supported for IMAP provider");
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (not exported — kept here for locality)
// ---------------------------------------------------------------------------

/**
 * Builds a flat query string from a ThreadsQuery object.
 * Used for translating structured query objects into the translateQuery format.
 */
function buildQueryString(query?: ThreadsQuery): string {
  if (!query) return "";

  const parts: string[] = [];
  if (query.fromEmail) parts.push(`from:${query.fromEmail}`);
  if (query.after) parts.push(`after:${formatDate(query.after)}`);
  if (query.before) parts.push(`before:${formatDate(query.before)}`);
  if (query.isUnread) parts.push("is:unread");
  // labelId / labelIds / type / excludeLabelNames: IMAP-specific handling
  // omitted since these are Gmail-specific concepts

  return parts.join(" ");
}

function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toISOString().slice(0, 10);
}

/**
 * Fetches only the threading headers for a single message by UID.
 * Lightweight — does not download the full body.
 */
async function fetchMessageHeadersRaw(
  client: ImapFlow,
  mailbox: string,
  uid: number,
): Promise<{
  messageId?: string;
  references?: string;
  inReplyTo?: string;
}> {
  await client.mailboxOpen(mailbox);
  const msg = await client.fetchOne(
    String(uid),
    {
      uid: true,
      headers: ["message-id", "references", "in-reply-to"],
    },
    { uid: true },
  );

  if (!msg || !msg.headers) return {};

  const text = msg.headers.toString("utf8");

  return {
    messageId: extractHeader(text, "message-id"),
    references: extractHeader(text, "references"),
    inReplyTo: extractHeader(text, "in-reply-to"),
  };
}
