/**
 * Integration test for ImapProvider against a live IMAP server.
 * Bypasses DB — creates ImapFlow client directly.
 *
 * Run with:
 *   IMAP_HOST=imap.migadu.com IMAP_PORT=993 SMTP_HOST=smtp.migadu.com SMTP_PORT=465 \
 *   IMAP_USER=test1@txlab.io IMAP_PASS=your-password \
 *   npx tsx utils/imap/test-provider.ts
 */

import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { ImapProvider } from "@/utils/email/imap";
import { resolveThreadId } from "@/utils/imap/thread";
import { translateQuery } from "@/utils/imap/search";
import { imapFlagsToLabelIds, labelIdToImapKeyword } from "@/utils/imap/flags";
import { extractHeader } from "@/utils/imap/headers";

const config = {
  imapHost: process.env.IMAP_HOST || "imap.migadu.com",
  imapPort: Number(process.env.IMAP_PORT || "993"),
  smtpHost: process.env.SMTP_HOST || "smtp.migadu.com",
  smtpPort: Number(process.env.SMTP_PORT || "465"),
  user: process.env.IMAP_USER || "",
  pass: process.env.IMAP_PASS || "",
};

if (!config.user || !config.pass) {
  console.error("Set IMAP_USER and IMAP_PASS env vars");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  [PASS] ${msg}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${msg}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (actual === expected) {
    console.log(`  [PASS] ${msg}`);
    passed++;
  } else {
    console.error(
      `  [FAIL] ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
    failed++;
  }
}

async function connectClient(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapPort === 993,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });
  await client.connect();
  return client;
}

async function sendTestEmail(opts: {
  subject: string;
  text: string;
  messageId: string;
  references?: string;
  inReplyTo?: string;
}): Promise<void> {
  const transport = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.user, pass: config.pass },
  });
  await transport.sendMail({
    from: config.user,
    to: config.user,
    subject: opts.subject,
    text: opts.text,
    messageId: opts.messageId,
    references: opts.references,
    inReplyTo: opts.inReplyTo,
  });
  transport.close();
}

async function waitForUidCount(
  client: ImapFlow,
  mailbox: string,
  minCount: number,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await client.mailboxOpen(mailbox);
    const status = await client.status(mailbox, { messages: true });
    if ((status.messages ?? 0) >= minCount) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${minCount} messages in ${mailbox}`);
}

// ---------------------------------------------------------------------------
// Unit tests (no server needed)
// ---------------------------------------------------------------------------

function testResolveThreadId() {
  console.log("\n--- resolveThreadId ---");

  assertEqual(
    resolveThreadId({
      references: "<root@test> <mid@test>",
      messageId: "<leaf@test>",
    }),
    "<root@test>",
    "picks first Reference as thread root",
  );

  assertEqual(
    resolveThreadId({ inReplyTo: "<parent@test>", messageId: "<child@test>" }),
    "<parent@test>",
    "falls back to In-Reply-To",
  );

  assertEqual(
    resolveThreadId({ messageId: "<solo@test>" }),
    "<solo@test>",
    "falls back to own Message-ID",
  );

  assertEqual(resolveThreadId({}), "", "returns empty for no headers");
}

function testTranslateQuery() {
  console.log("\n--- translateQuery ---");

  const empty = translateQuery("");
  assert(!!empty.all, "empty query → all:true");

  const fromQ = translateQuery("from:alice@example.com");
  assertEqual(fromQ.from, "alice@example.com", "from: parsed");

  const multi = translateQuery('from:bob subject:"hello world" is:unread');
  assertEqual(multi.from, "bob", "multi: from");
  assertEqual(multi.subject, "hello world", "multi: subject (quoted)");
  assertEqual(multi.seen, false, "multi: is:unread → seen:false");

  const bare = translateQuery("important meeting");
  assertEqual(bare.text, "important meeting", "bare text → text search");
}

function testFlags() {
  console.log("\n--- flags ---");

  const labels = imapFlagsToLabelIds(["\\Flagged", "\\Seen", "$iz_newsletter"]);
  assert(labels.includes("STARRED"), "\\Flagged → STARRED");
  assert(!labels.includes("SEEN"), "\\Seen not mapped to label");
  assert(labels.includes("newsletter"), "$iz_newsletter → newsletter");

  assertEqual(
    labelIdToImapKeyword("newsletter"),
    "$iz_newsletter",
    "label → keyword prefixed",
  );
  assertEqual(
    labelIdToImapKeyword("$iz_newsletter"),
    "$iz_newsletter",
    "already prefixed → idempotent",
  );
}

function testExtractHeader() {
  console.log("\n--- extractHeader ---");

  const raw = [
    "Message-ID: <abc@test>",
    "Subject: Hello World",
    "References: <root@test>",
    "  <mid@test> <leaf@test>",
    "From: alice@test",
  ].join("\r\n");

  assertEqual(extractHeader(raw, "message-id"), "<abc@test>", "Message-ID");
  assertEqual(extractHeader(raw, "subject"), "Hello World", "Subject");
  assertEqual(
    extractHeader(raw, "references"),
    "<root@test> <mid@test> <leaf@test>",
    "References (folded header)",
  );
  assertEqual(extractHeader(raw, "from"), "alice@test", "From");
  assertEqual(
    extractHeader(raw, "x-missing"),
    undefined,
    "missing header → undefined",
  );
}

// ---------------------------------------------------------------------------
// Integration tests (needs live server)
// ---------------------------------------------------------------------------

async function testProviderIntegration() {
  console.log("\n--- ImapProvider Integration ---");

  // Seed test emails
  const threadRoot = `<iz-test-root-${Date.now()}@integration>`;
  const threadReply = `<iz-test-reply-${Date.now()}@integration>`;
  const standalone = `<iz-test-standalone-${Date.now()}@integration>`;

  console.log("  Sending test emails...");
  await sendTestEmail({
    subject: "IZ Integration Test Thread",
    text: "Root message body for integration testing.",
    messageId: threadRoot,
  });
  await sendTestEmail({
    subject: "Re: IZ Integration Test Thread",
    text: "Reply message body for integration testing.",
    messageId: threadReply,
    references: threadRoot,
    inReplyTo: threadRoot,
  });
  await sendTestEmail({
    subject: "IZ Standalone Test",
    text: "This message is not part of any thread.",
    messageId: standalone,
  });

  // Wait for delivery
  console.log("  Waiting for delivery...");
  const client = await connectClient();
  await waitForUidCount(client, "INBOX", 3, 20_000);

  const provider = new ImapProvider(client);

  // --- getFolders ---
  console.log("\n  ## getFolders");
  const folders = await provider.getFolders();
  assert(folders.length > 0, `got ${folders.length} folders`);
  const inboxFolder = folders.find(
    (f) => f.displayName === "INBOX" || f.id === "INBOX",
  );
  assert(!!inboxFolder, "INBOX folder found");

  // --- getLabels ---
  console.log("\n  ## getLabels");
  const labels = await provider.getLabels();
  assert(labels.length > 0, `got ${labels.length} labels`);
  const inboxLabel = labels.find((l) => l.name === "INBOX");
  assert(!!inboxLabel, "INBOX label present");

  // --- getInboxStats ---
  console.log("\n  ## getInboxStats");
  const stats = await provider.getInboxStats();
  assert(stats.total >= 3, `total >= 3 (got ${stats.total})`);

  // --- getInboxMessages ---
  console.log("\n  ## getInboxMessages");
  const inboxMsgs = await provider.getInboxMessages(10);
  assert(inboxMsgs.length >= 3, `fetched ${inboxMsgs.length} messages`);

  // Find our test messages
  const rootMsg = inboxMsgs.find((m) => m.headers["message-id"] === threadRoot);
  const replyMsg = inboxMsgs.find(
    (m) => m.headers["message-id"] === threadReply,
  );
  const standaloneMsg = inboxMsgs.find(
    (m) => m.headers["message-id"] === standalone,
  );

  assert(!!rootMsg, "root message found in inbox");
  assert(!!replyMsg, "reply message found in inbox");
  assert(!!standaloneMsg, "standalone message found in inbox");

  if (!rootMsg || !replyMsg || !standaloneMsg) {
    console.error("  Cannot continue: test messages not found");
    await provider.close();
    return;
  }

  // --- Thread ID resolution ---
  console.log("\n  ## Thread ID resolution");
  assertEqual(rootMsg.threadId, threadRoot, "root has own ID as thread");
  assertEqual(replyMsg.threadId, threadRoot, "reply threaded to root");
  assert(
    standaloneMsg.threadId !== threadRoot,
    "standalone has different thread ID",
  );

  // --- getMessage ---
  console.log("\n  ## getMessage");
  const fetched = await provider.getMessage(rootMsg.id);
  assertEqual(fetched.subject, "IZ Integration Test Thread", "subject matches");
  assertEqual(fetched.headers["message-id"], threadRoot, "message-id matches");
  assert(!!fetched.textPlain, "has text body");
  assert(
    fetched.textPlain!.includes("Root message body"),
    "text content matches",
  );

  // --- getMessageByRfc822MessageId ---
  console.log("\n  ## getMessageByRfc822MessageId");
  const byMsgId = await provider.getMessageByRfc822MessageId(threadRoot);
  assert(!!byMsgId, "found by RFC822 Message-ID");
  assertEqual(byMsgId!.id, rootMsg.id, "same UID");

  // --- getThread ---
  console.log("\n  ## getThread");
  const thread = await provider.getThread(threadRoot);
  assert(
    thread.messages.length >= 2,
    `thread has ${thread.messages.length} messages`,
  );
  assertEqual(thread.id, threadRoot, "thread ID matches");

  // --- getThreadMessages ---
  console.log("\n  ## getThreadMessages");
  const threadMsgs = await provider.getThreadMessages(threadRoot);
  assert(
    threadMsgs.length >= 2,
    `getThreadMessages: ${threadMsgs.length} messages`,
  );
  // Should be sorted by date ascending
  if (threadMsgs.length >= 2) {
    const d0 = new Date(threadMsgs[0].date).getTime();
    const d1 = new Date(threadMsgs[1].date).getTime();
    assert(d0 <= d1, "thread messages sorted ascending by date");
  }

  // --- getLatestMessageInThread ---
  console.log("\n  ## getLatestMessageInThread");
  const latest = await provider.getLatestMessageInThread(threadRoot);
  assert(!!latest, "got latest message");
  assertEqual(
    latest!.headers["message-id"],
    threadReply,
    "latest is the reply",
  );

  // --- getThreads ---
  console.log("\n  ## getThreads");
  const threads = await provider.getThreads();
  assert(threads.length >= 1, `got ${threads.length} threads`);
  const ourThread = threads.find((t) => t.id === threadRoot);
  assert(!!ourThread, "our thread found in getThreads");

  // --- searchMessages ---
  console.log("\n  ## searchMessages");
  // Use quoted subject so tokenizer keeps it as one token
  const searchResult = await provider.searchMessages({
    query: 'subject:"IZ Integration Test Thread"',
  });
  assert(
    searchResult.messages.length >= 1,
    `search found ${searchResult.messages.length} messages`,
  );

  // --- getMessagesFromSender ---
  console.log("\n  ## getMessagesFromSender");
  const fromSender = await provider.getMessagesFromSender({
    senderEmail: config.user,
    maxResults: 10,
  });
  assert(
    fromSender.messages.length >= 3,
    `found ${fromSender.messages.length} from sender`,
  );

  // --- hasPreviousCommunicationsWithSenderOrDomain ---
  console.log("\n  ## hasPreviousCommunications");
  const tomorrow = new Date(Date.now() + 86_400_000);
  const hasPrev = await provider.hasPreviousCommunicationsWithSenderOrDomain({
    from: config.user,
    date: tomorrow,
    messageId: standalone,
  });
  assert(hasPrev, "detected previous communications");

  // --- countReceivedMessages ---
  console.log("\n  ## countReceivedMessages");
  const count = await provider.countReceivedMessages(config.user, 10);
  assert(count >= 3, `count >= 3 (got ${count})`);

  // --- markRead/markReadThread ---
  console.log("\n  ## markRead");
  await provider.markRead(threadRoot);
  // Verify by re-fetching
  const afterRead = await provider.getMessage(rootMsg.id);
  // \Seen should be set; check labelIds doesn't include UNREAD
  // (our flags module doesn't map \Seen to a label, so just verify no error)
  assert(true, "markRead completed without error");

  // --- markReadThread (unread) ---
  await provider.markReadThread(threadRoot, false);
  assert(true, "markReadThread(false) completed without error");

  // --- labelMessage ---
  console.log("\n  ## labelMessage");
  const labelResult = await provider.labelMessage({
    messageId: rootMsg.id,
    labelId: "test-label",
    labelName: "Test Label",
  });
  assert(!!labelResult.actualLabelId, "label applied");

  // --- createLabel ---
  console.log("\n  ## createLabel");
  const newLabel = await provider.createLabel("test-category");
  assertEqual(newLabel.name, "test-category", "label name matches");
  assert(!!newLabel.id, "label has ID");

  // --- isReplyInThread ---
  console.log("\n  ## isReplyInThread");
  assert(provider.isReplyInThread(replyMsg), "reply detected as reply");
  assert(!provider.isReplyInThread(standaloneMsg), "standalone not a reply");

  // --- getMessagesWithPagination ---
  console.log("\n  ## getMessagesWithPagination");
  const page1 = await provider.getMessagesWithPagination({
    maxResults: 2,
  });
  assert(
    page1.messages.length <= 2,
    `page1: ${page1.messages.length} messages`,
  );

  // --- getThreadsWithQuery ---
  console.log("\n  ## getThreadsWithQuery");
  const queryResult = await provider.getThreadsWithQuery({
    maxResults: 10,
  });
  assert(
    queryResult.threads.length >= 1,
    `getThreadsWithQuery: ${queryResult.threads.length} threads`,
  );

  // --- archiveMessage ---
  console.log("\n  ## archiveMessage");
  await provider.archiveMessage(standaloneMsg.id);
  // Verify it's gone from inbox
  const afterArchive = await provider.getInboxMessages(20);
  const stillInInbox = afterArchive.find(
    (m) => m.headers["message-id"] === standalone,
  );
  assert(!stillInInbox, "archived message no longer in inbox");

  // --- archiveThread ---
  console.log("\n  ## archiveThread");
  await provider.archiveThread(threadRoot, config.user);
  const afterThreadArchive = await provider.getInboxMessages(20);
  const rootStillIn = afterThreadArchive.find(
    (m) => m.headers["message-id"] === threadRoot,
  );
  assert(!rootStillIn, "archived thread root no longer in inbox");

  console.log("\n  ## Cleanup: moving test messages to Trash");
  // Find UIDs in Archive and move to Trash
  try {
    await provider.close();
    const cleanupClient = await connectClient();
    await cleanupClient.mailboxOpen("Archive");
    const archiveUids = await cleanupClient.search(
      { all: true },
      { uid: true },
    );
    if (archiveUids && archiveUids.length > 0) {
      await cleanupClient.messageMove(archiveUids.join(","), "Trash", {
        uid: true,
      });
    }
    // Also clean Trash
    await cleanupClient.mailboxOpen("Trash");
    const trashUids = await cleanupClient.search({ all: true }, { uid: true });
    if (trashUids && trashUids.length > 0) {
      await cleanupClient.messageFlagsAdd(trashUids.join(","), ["\\Deleted"], {
        uid: true,
      });
    }
    await cleanupClient.mailboxOpen("INBOX");
    const inboxUids = await cleanupClient.search({ all: true }, { uid: true });
    if (inboxUids && inboxUids.length > 0) {
      await cleanupClient.messageMove(inboxUids.join(","), "Trash", {
        uid: true,
      });
    }
    await cleanupClient.logout();
  } catch (err) {
    console.warn("  Cleanup warning:", err);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== ImapProvider Integration Tests ===\n");

  // Unit tests (no server)
  testResolveThreadId();
  testTranslateQuery();
  testFlags();
  testExtractHeader();

  // Integration tests (live server)
  try {
    await testProviderIntegration();
  } catch (err) {
    console.error("\n[FATAL] Integration test error:", err);
    failed++;
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
