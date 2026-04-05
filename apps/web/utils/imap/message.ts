import { simpleParser, type ParsedMail } from "mailparser";
import type { ImapFlow, MessageEnvelopeObject } from "imapflow";
import type { ParsedMessage, Attachment } from "@/utils/types";
import type { Logger } from "@/utils/logger";
import { createScopedLogger } from "@/utils/logger";
import { resolveThreadId } from "@/utils/imap/thread";
import { imapFlagsToLabelIds } from "@/utils/imap/flags";

export interface MessageHeaders {
  date?: string;
  from?: string;
  inReplyTo?: string;
  messageId?: string;
  references?: string;
  subject?: string;
  to?: string;
}

/**
 * Fetches a full message by UID from the specified mailbox, parses it with
 * mailparser, and returns a ParsedMessage.
 */
export async function fetchAndParseMessage(
  client: ImapFlow,
  mailbox: string,
  uid: number,
  logger?: Logger,
): Promise<ParsedMessage> {
  const scopedLogger = logger ?? createScopedLogger("imap/message");

  await client.mailboxOpen(mailbox);

  const msg = await client.fetchOne(
    String(uid),
    {
      uid: true,
      flags: true,
      envelope: true,
      internalDate: true,
      source: true,
    },
    { uid: true },
  );

  if (!msg) {
    throw new Error(`Message UID ${uid} not found in mailbox "${mailbox}"`);
  }

  if (!msg.source) {
    throw new Error(
      `No source/body returned for UID ${uid} in mailbox "${mailbox}"`,
    );
  }

  scopedLogger.trace("Parsing message", { uid, mailbox });

  const parsed = await simpleParser(msg.source);
  const flags = msg.flags ? [...msg.flags] : [];

  return imapMessageToParsedMessage(uid, mailbox, parsed, msg.envelope, flags);
}

/**
 * Lightweight fetch of just the headers for a message.
 * Used for threading operations without downloading full body.
 */
export async function fetchMessageHeaders(
  client: ImapFlow,
  mailbox: string,
  uid: number,
): Promise<MessageHeaders> {
  await client.mailboxOpen(mailbox);

  const msg = await client.fetchOne(
    String(uid),
    {
      uid: true,
      headers: [
        "message-id",
        "references",
        "in-reply-to",
        "subject",
        "from",
        "to",
        "date",
      ],
    },
    { uid: true },
  );

  if (!msg || !msg.headers) {
    return {};
  }

  const headersText = msg.headers.toString("utf8");
  return {
    messageId: extractHeader(headersText, "message-id"),
    references: extractHeader(headersText, "references"),
    inReplyTo: extractHeader(headersText, "in-reply-to"),
    subject: extractHeader(headersText, "subject"),
    from: extractHeader(headersText, "from"),
    to: extractHeader(headersText, "to"),
    date: extractHeader(headersText, "date"),
  };
}

/**
 * Converts mailparser ParsedMail + IMAP envelope + flags into the app's ParsedMessage format.
 */
export function imapMessageToParsedMessage(
  uid: number,
  mailboxName: string,
  parsed: ParsedMail,
  envelope: MessageEnvelopeObject | undefined,
  flags: string[],
): ParsedMessage {
  const messageId = parsed.messageId ?? envelope?.messageId ?? undefined;
  const references =
    typeof parsed.references === "string"
      ? parsed.references
      : Array.isArray(parsed.references)
        ? parsed.references.join(" ")
        : undefined;
  const inReplyTo = parsed.inReplyTo ?? undefined;

  const threadId = resolveThreadId({ messageId, references, inReplyTo });

  const from = formatAddresses(parsed.from?.value ?? envelope?.from);
  const to = formatAddresses(
    parsed.to
      ? Array.isArray(parsed.to)
        ? parsed.to.flatMap((a) => a.value)
        : parsed.to.value
      : envelope?.to,
  );
  const cc = formatAddresses(
    parsed.cc
      ? Array.isArray(parsed.cc)
        ? parsed.cc.flatMap((a) => a.value)
        : parsed.cc.value
      : envelope?.cc,
  );
  const bcc = formatAddresses(
    parsed.bcc
      ? Array.isArray(parsed.bcc)
        ? parsed.bcc.flatMap((a) => a.value)
        : parsed.bcc.value
      : envelope?.bcc,
  );

  const dateValue = parsed.date ?? envelope?.date;
  const dateStr = dateValue
    ? dateValue.toISOString()
    : new Date(0).toISOString();

  const subject = parsed.subject ?? envelope?.subject ?? "";

  const textPlain = parsed.text ?? undefined;
  const textHtml =
    parsed.html !== false ? (parsed.html ?? undefined) : undefined;

  const snippet = generateSnippet(textPlain, textHtml);

  const labelIds = imapFlagsToLabelIds(flags);

  const attachments = mapAttachments(parsed, false);
  const inline = mapAttachments(parsed, true);

  return {
    id: String(uid),
    threadId,
    historyId: "0",
    date: dateStr,
    internalDate: dateStr,
    subject,
    snippet,
    textPlain,
    textHtml,
    labelIds,
    attachments,
    inline,
    parentFolderId: mailboxName,
    headers: {
      from,
      to,
      cc: cc || undefined,
      bcc: bcc || undefined,
      date: dateStr,
      subject,
      "message-id": messageId,
      references,
      "in-reply-to": inReplyTo,
      "list-unsubscribe": getHeaderString(parsed, "list-unsubscribe"),
    },
  };
}

function formatAddresses(
  addresses: Array<{ name?: string; address?: string }> | undefined | null,
): string {
  if (!addresses || addresses.length === 0) return "";
  return addresses
    .map((a) => {
      if (a.name && a.address) return `${a.name} <${a.address}>`;
      return a.address ?? a.name ?? "";
    })
    .filter(Boolean)
    .join(", ");
}

function generateSnippet(
  textPlain: string | undefined,
  textHtml: string | undefined,
): string {
  const MAX = 200;

  if (textPlain) {
    return textPlain.replace(/\s+/g, " ").trim().slice(0, MAX);
  }

  if (textHtml) {
    // Strip HTML tags for snippet
    const stripped = textHtml
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, MAX);
  }

  return "";
}

function mapAttachments(parsed: ParsedMail, inlineOnly: boolean): Attachment[] {
  if (!parsed.attachments) return [];

  return parsed.attachments
    .filter((att) => {
      const isInline = att.contentDisposition === "inline" || !!att.contentId;
      return inlineOnly ? isInline : !isInline;
    })
    .map((att) => ({
      attachmentId:
        att.contentId ?? att.checksum ?? `${att.filename}-${att.size}`,
      filename: att.filename ?? "unknown",
      mimeType: att.contentType,
      size: att.size,
      headers: {
        "content-description": "",
        "content-id": att.cid ?? "",
        "content-transfer-encoding": "",
        "content-type": att.contentType,
      },
    }));
}

function getHeaderString(
  parsed: ParsedMail,
  headerName: string,
): string | undefined {
  const val = parsed.headers.get(headerName);
  if (!val) return undefined;
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val[0] as string | undefined;
  return undefined;
}

/**
 * Extracts a single header value from raw header block text.
 * Handles folded (multi-line) headers.
 */
function extractHeader(headersText: string, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  const lines = headersText.split(/\r?\n/);

  let value: string | undefined;
  let capturing = false;

  for (const line of lines) {
    if (capturing) {
      if (/^\s/.test(line)) {
        value = `${value ?? ""} ${line.trim()}`;
        continue;
      }
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
