import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withError } from "@/utils/middleware";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import { pollImapAccount } from "@/utils/imap/sync";
import type { Logger } from "@/utils/logger";

export const maxDuration = 300;

const CONCURRENCY = 3;

export const GET = withError("imap/poll", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(new Error("Unauthorized request: api/imap/poll"));
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await pollAllImapAccounts(request.logger);
  return NextResponse.json(result);
});

export const POST = withError("imap/poll", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(new Error("Unauthorized cron request: api/imap/poll"));
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await pollAllImapAccounts(request.logger);
  return NextResponse.json(result);
});

async function pollAllImapAccounts(logger: Logger) {
  const accounts = await prisma.emailAccount.findMany({
    where: {
      account: {
        provider: "imap",
        disconnectedAt: null,
      },
    },
    select: {
      id: true,
      email: true,
    },
  });

  logger.info("IMAP poll: accounts found", { total: accounts.length });

  let polled = 0;
  let newMessages = 0;
  const errors: Array<{ emailAccountId: string; error: string }> = [];

  // Process accounts with bounded concurrency
  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (account) => {
        const accountLogger = logger.with({
          emailAccountId: account.id,
          email: account.email,
        });

        const result = await pollImapAccount(account.id, accountLogger);
        return result;
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const account = batch[j];

      if (result.status === "fulfilled") {
        polled += 1;
        newMessages += result.value.newMessages;
      } else {
        const errorMsg =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);

        logger.error("IMAP poll failed for account", {
          emailAccountId: account.id,
          error: errorMsg,
        });

        errors.push({ emailAccountId: account.id, error: errorMsg });
      }
    }
  }

  logger.info("IMAP poll complete", {
    polled,
    newMessages,
    errors: errors.length,
  });

  return { polled, newMessages, errors };
}
