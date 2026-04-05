import prisma from "@/utils/prisma";
import { createImapClient } from "@/utils/imap/client";
import { fetchAndParseMessage } from "@/utils/imap/message";
import { searchByUid } from "@/utils/imap/uid-helpers";
import { ImapProvider } from "@/utils/email/imap";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { isPremium, hasAiAccess } from "@/utils/premium";
import { captureException } from "@/utils/error";
import { env } from "@/env";
import type { Logger } from "@/utils/logger";
import { createScopedLogger } from "@/utils/logger";

const FOLDER = "INBOX";

/**
 * Polls a single IMAP account for new messages and processes them through
 * the rule pipeline.
 *
 * Returns the count of newly processed messages.
 */
export async function pollImapAccount(
  emailAccountId: string,
  logger: Logger,
): Promise<{ newMessages: number }> {
  const scopedLogger = (logger ?? createScopedLogger("imap/sync")).with({
    emailAccountId,
    folder: FOLDER,
  });

  const client = await createImapClient(emailAccountId, scopedLogger);

  try {
    // Open INBOX and read its current state
    const mailbox = await client.mailboxOpen(FOLDER);
    const currentUidValidity = mailbox.uidValidity
      ? Number(mailbox.uidValidity)
      : null;

    // Fetch stored sync state for this account+folder
    const syncState = await prisma.imapSyncState.findUnique({
      where: {
        emailAccountId_folder: {
          emailAccountId,
          folder: FOLDER,
        },
      },
    });

    let lastUid = syncState?.lastUid ?? 0;

    // UIDVALIDITY check — if it changed, all UIDs are invalid
    if (
      currentUidValidity !== null &&
      syncState?.uidValidity !== null &&
      syncState?.uidValidity !== undefined &&
      syncState.uidValidity !== currentUidValidity
    ) {
      scopedLogger.warn("UIDVALIDITY changed — resetting sync state", {
        stored: syncState.uidValidity,
        current: currentUidValidity,
      });

      await prisma.imapSyncState.delete({
        where: {
          emailAccountId_folder: {
            emailAccountId,
            folder: FOLDER,
          },
        },
      });

      // Full resync: start from UID 1
      lastUid = 0;
    }

    // Search for UIDs we haven't seen yet
    const startUid = lastUid + 1;
    const newUids = await searchByUid(client, FOLDER, {
      uid: `${startUid}:*`,
    });

    scopedLogger.info("IMAP poll: new UIDs found", { count: newUids.length });

    if (newUids.length === 0) {
      // Nothing new — just ensure sync state exists with current uidValidity
      await upsertSyncState(emailAccountId, lastUid, currentUidValidity);
      return { newMessages: 0 };
    }

    // Load the email account data needed for the processing pipeline
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: {
        id: true,
        email: true,
        userId: true,
        about: true,
        multiRuleSelectionEnabled: true,
        timezone: true,
        calendarBookingLink: true,
        draftReplyConfidence: true,
        autoCategorizeSenders: true,
        filingEnabled: true,
        filingPrompt: true,
        filingConfirmationSendEmail: true,
        account: {
          select: { provider: true },
        },
        rules: {
          where: { enabled: true },
          include: { actions: true },
        },
        user: {
          select: {
            aiProvider: true,
            aiModel: true,
            aiApiKey: true,
            premium: {
              select: {
                lemonSqueezyRenewsAt: true,
                stripeSubscriptionStatus: true,
                tier: true,
              },
            },
          },
        },
      },
    });

    if (!emailAccount) {
      scopedLogger.error("Email account not found");
      return { newMessages: 0 };
    }

    // Premium + AI access checks (mirrors validateWebhookAccount logic)
    const premiumActive = env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS
      ? true
      : isPremium(
          emailAccount.user.premium?.lemonSqueezyRenewsAt || null,
          emailAccount.user.premium?.stripeSubscriptionStatus || null,
        );

    if (!premiumActive) {
      scopedLogger.info("Skipping IMAP poll — account not premium");
      return { newMessages: 0 };
    }

    const premiumTier = env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS
      ? ("PROFESSIONAL_ANNUALLY" as const)
      : (emailAccount.user.premium?.tier ?? null);

    const userHasAiAccess = hasAiAccess(
      premiumTier,
      !!emailAccount.user.aiApiKey,
    );

    const hasAutomationRules = emailAccount.rules.length > 0;
    const hasFilingEnabled =
      emailAccount.filingEnabled && !!emailAccount.filingPrompt;

    if (!hasAutomationRules && !hasFilingEnabled) {
      scopedLogger.info("Skipping IMAP poll — no rules and filing not enabled");
      await upsertSyncState(
        emailAccountId,
        Math.max(...newUids),
        currentUidValidity,
      );
      return { newMessages: 0 };
    }

    // Create the IMAP provider reusing the already-connected client
    const provider = new ImapProvider(client, scopedLogger, emailAccountId);

    let processed = 0;
    let highestUid = lastUid;

    for (const uid of newUids) {
      const msgLogger = scopedLogger.with({ uid });

      try {
        const parsedMessage = await fetchAndParseMessage(
          client,
          FOLDER,
          uid,
          msgLogger,
        );

        await processHistoryItem(
          {
            messageId: parsedMessage.id,
            threadId: parsedMessage.threadId,
            message: parsedMessage,
          },
          {
            provider,
            emailAccount: {
              ...emailAccount,
              account: { provider: emailAccount.account?.provider ?? "imap" },
            },
            hasAutomationRules,
            hasAiAccess: userHasAiAccess,
            rules: emailAccount.rules,
            logger: msgLogger,
          },
        );

        processed += 1;
      } catch (error) {
        msgLogger.error("Failed to process IMAP message", {
          uid,
          error: error instanceof Error ? error.message : error,
        });
        captureException(error, { emailAccountId, extra: { uid } });
      }

      // Track the highest UID we've seen regardless of processing success
      if (uid > highestUid) highestUid = uid;
    }

    // Persist updated sync state
    await upsertSyncState(emailAccountId, highestUid, currentUidValidity);

    scopedLogger.info("IMAP poll complete", {
      total: newUids.length,
      processed,
    });

    return { newMessages: processed };
  } finally {
    try {
      await client.logout();
    } catch {
      // Best-effort disconnect
    }
  }
}

async function upsertSyncState(
  emailAccountId: string,
  lastUid: number,
  uidValidity: number | null,
) {
  await prisma.imapSyncState.upsert({
    where: {
      emailAccountId_folder: {
        emailAccountId,
        folder: FOLDER,
      },
    },
    create: {
      emailAccountId,
      folder: FOLDER,
      lastUid,
      uidValidity,
    },
    update: {
      lastUid,
      uidValidity,
    },
  });
}
