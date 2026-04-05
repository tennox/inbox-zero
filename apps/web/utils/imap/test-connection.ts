/**
 * Standalone IMAP connection test script.
 * Run with: npx tsx utils/imap/test-connection.ts
 *
 * Set these env vars before running:
 *   IMAP_HOST=imap.posteo.de
 *   IMAP_PORT=993
 *   IMAP_USER=you@posteo.de
 *   IMAP_PASS=your-app-password
 *   SMTP_HOST=posteo.de
 *   SMTP_PORT=587
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";

const config = {
  imapHost: process.env.IMAP_HOST || "imap.posteo.de",
  imapPort: Number(process.env.IMAP_PORT || "993"),
  smtpHost: process.env.SMTP_HOST || "posteo.de",
  smtpPort: Number(process.env.SMTP_PORT || "587"),
  user: process.env.IMAP_USER || "",
  pass: process.env.IMAP_PASS || "",
};

if (!config.user || !config.pass) {
  console.error("Set IMAP_USER and IMAP_PASS env vars");
  process.exit(1);
}

async function testImap() {
  console.log("\n--- IMAP Connection Test ---");
  console.log(`Host: ${config.imapHost}:${config.imapPort}`);
  console.log(`User: ${config.user}\n`);

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapPort === 993,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });

  try {
    await client.connect();
    console.log("[OK] Connected to IMAP server");

    // Capabilities
    const caps = Array.from(client.capabilities?.keys?.() || []);
    console.log(`[OK] Capabilities: ${caps.join(", ")}`);

    const hasThread = caps.some((c) => c.startsWith("THREAD"));
    const hasIdle = caps.includes("IDLE");
    const hasCondstore = caps.includes("CONDSTORE");
    const hasMove = caps.includes("MOVE");
    const hasSort = caps.includes("SORT");
    const hasSpecialUse = caps.includes("SPECIAL-USE");
    console.log(
      `\n  THREAD: ${hasThread}, IDLE: ${hasIdle}, CONDSTORE: ${hasCondstore}`,
    );
    console.log(
      `  MOVE: ${hasMove}, SORT: ${hasSort}, SPECIAL-USE: ${hasSpecialUse}`,
    );

    // List folders
    const folders = await client.list();
    console.log(`\n[OK] Folders (${folders.length}):`);
    for (const f of folders) {
      const special = f.specialUse ? ` (${f.specialUse})` : "";
      console.log(`  ${f.path}${special}`);
    }

    // Open INBOX
    const inbox = await client.mailboxOpen("INBOX");
    console.log(
      `\n[OK] INBOX: ${inbox.exists} messages, uidValidity=${inbox.uidValidity}, uidNext=${inbox.uidNext}`,
    );

    // Fetch 3 recent messages
    const messages: Array<{
      uid: number;
      subject: string;
      from: string;
      date: string;
    }> = [];

    if (inbox.exists > 0) {
      let count = 0;
      for await (const msg of client.fetch(
        `${Math.max(1, inbox.exists - 2)}:*`,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        },
      )) {
        messages.push({
          uid: msg.uid,
          subject: msg.envelope?.subject || "(no subject)",
          from: msg.envelope?.from?.[0]?.address || "unknown",
          date: msg.envelope?.date?.toISOString() || "unknown",
        });
        count++;
        if (count >= 3) break;
      }

      console.log("\n[OK] Recent messages:");
      for (const m of messages) {
        console.log(
          `  UID ${m.uid}: "${m.subject}" from ${m.from} (${m.date})`,
        );
      }
    } else {
      console.log("\n[INFO] INBOX is empty — skipping message fetch");
    }

    // Test THREAD if available
    if (hasThread) {
      console.log(
        "\n[OK] Server supports THREAD — threading will use server-side grouping",
      );
    } else {
      console.log(
        "\n[INFO] No THREAD support — will use References header grouping",
      );
    }

    // Fetch one full message and parse (skip if inbox empty)
    if (messages.length > 0) {
      const uid = messages[0].uid;
      const raw = await client.download(String(uid), undefined, { uid: true });
      const parsed = await simpleParser(raw.content);
      console.log(`\n[OK] Parsed UID ${uid}:`);
      console.log(`  Subject: ${parsed.subject}`);
      console.log(`  From: ${parsed.from?.text}`);
      console.log(`  Date: ${parsed.date?.toISOString()}`);
      console.log(`  Text length: ${parsed.text?.length || 0} chars`);
      console.log(
        `  HTML length: ${parsed.html?.toString().length || 0} chars`,
      );
      console.log(`  Attachments: ${parsed.attachments?.length || 0}`);
      console.log(`  References: ${parsed.references?.join(", ") || "(none)"}`);
      console.log(`  Message-ID: ${parsed.messageId || "(none)"}`);
    }

    await client.logout();
    console.log("\n[OK] IMAP test passed!\n");
  } catch (err) {
    console.error("\n[FAIL] IMAP error:", err);
    try {
      await client.logout();
    } catch {
      // ignore
    }
    process.exit(1);
  }
}

async function testSmtp() {
  console.log("\n--- SMTP Connection Test ---");
  console.log(`Host: ${config.smtpHost}:${config.smtpPort}\n`);

  const transport = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.user, pass: config.pass },
  });

  try {
    await transport.verify();
    console.log("[OK] SMTP connection verified!\n");
    transport.close();
  } catch (err) {
    console.error("[FAIL] SMTP error:", err);
    transport.close();
    process.exit(1);
  }
}

async function main() {
  await testImap();
  await testSmtp();
  console.log("All tests passed!");
}

main();
