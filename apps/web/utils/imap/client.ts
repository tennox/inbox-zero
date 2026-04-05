import { ImapFlow } from "imapflow";
import { createTransport, type Transporter } from "nodemailer";
import prisma from "@/utils/prisma";
import { decryptToken } from "@/utils/encryption";
import { createScopedLogger, type Logger } from "@/utils/logger";

export interface ImapCapabilities {
  hasCondstore: boolean; // CONDSTORE
  hasIdle: boolean; // IDLE
  hasMove: boolean; // MOVE
  hasNotify: boolean; // NOTIFY
  hasSnippet: boolean; // SNIPPET=FUZZY or PREVIEW
  hasSort: boolean; // SORT
  hasSpecialUse: boolean; // SPECIAL-USE
  hasThread: boolean; // THREAD=REFERENCES
}

/**
 * Creates and connects an ImapFlow client for the given email account.
 * Fetches ImapCredential from DB, decrypts password, and returns a connected client.
 */
export async function createImapClient(
  emailAccountId: string,
  logger?: Logger,
): Promise<ImapFlow> {
  const scopedLogger = logger ?? createScopedLogger("imap/client");

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      account: {
        select: {
          imapCredential: true,
        },
      },
    },
  });

  const credential = emailAccount?.account?.imapCredential;
  if (!credential) {
    throw new Error(
      `No IMAP credential found for emailAccountId: ${emailAccountId}`,
    );
  }

  const password = decryptToken(credential.password);
  if (!password) {
    throw new Error(
      `Failed to decrypt IMAP password for emailAccountId: ${emailAccountId}`,
    );
  }

  const client = new ImapFlow({
    host: credential.imapHost,
    port: credential.imapPort,
    secure: credential.imapPort === 993,
    auth: {
      user: credential.username,
      pass: password,
    },
    // Disable ImapFlow's built-in logger; we use our own
    logger: false,
    disableAutoIdle: true,
  });

  client.on("error", (error: Error) => {
    scopedLogger.error("IMAP connection error", { error: error.message });
  });

  await client.connect();

  scopedLogger.info("IMAP client connected", {
    host: credential.imapHost,
    port: credential.imapPort,
    user: credential.username,
  });

  return client;
}

/**
 * Creates a nodemailer SMTP transport for the given email account.
 * Fetches ImapCredential from DB, decrypts password, and returns a configured transporter.
 */
export async function createSmtpTransport(
  emailAccountId: string,
): Promise<Transporter> {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      account: {
        select: {
          imapCredential: true,
        },
      },
    },
  });

  const credential = emailAccount?.account?.imapCredential;
  if (!credential) {
    throw new Error(
      `No IMAP credential found for emailAccountId: ${emailAccountId}`,
    );
  }

  const password = decryptToken(credential.password);
  if (!password) {
    throw new Error(
      `Failed to decrypt IMAP password for emailAccountId: ${emailAccountId}`,
    );
  }

  const transporter = createTransport({
    host: credential.smtpHost,
    port: credential.smtpPort,
    secure: credential.smtpPort === 465,
    auth: {
      user: credential.username,
      pass: password,
    },
  });

  return transporter;
}

/**
 * Inspects the capabilities of a connected ImapFlow client.
 * Must be called after client.connect().
 */
export function getImapCapabilities(client: ImapFlow): ImapCapabilities {
  const caps = client.capabilities;

  // ImapFlow stores capabilities as a Map<string, boolean | number>
  // Keys are uppercased capability strings
  const hasCapability = (name: string): boolean => {
    return caps.has(name) && caps.get(name) !== false;
  };

  return {
    hasThread:
      hasCapability("THREAD=REFERENCES") ||
      hasCapability("THREAD=ORDEREDSUBJECT"),
    hasIdle: hasCapability("IDLE"),
    hasCondstore: hasCapability("CONDSTORE") || hasCapability("QRESYNC"),
    hasMove: hasCapability("MOVE"),
    hasSort: hasCapability("SORT"),
    hasNotify: hasCapability("NOTIFY"),
    hasSnippet:
      hasCapability("SNIPPET=FUZZY") || hasCapability("PREVIEW=FUZZY"),
    hasSpecialUse: hasCapability("SPECIAL-USE"),
  };
}
