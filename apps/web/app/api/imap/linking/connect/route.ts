import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import { imapConnectionSchema } from "@/utils/imap/validation";
import { encryptToken } from "@/utils/encryption";
import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";

export type PostConnectImapResponse = { emailAccountId: string };

export const POST = withAuth("imap/linking/connect", async (request) => {
  const userId = request.auth.userId;

  const body = await request.json();
  const parsed = imapConnectionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }

  const { email, imapHost, imapPort, smtpHost, smtpPort, username, password } =
    parsed.data;

  const encryptedPassword = encryptToken(password);
  if (!encryptedPassword) {
    return NextResponse.json(
      { error: "Failed to encrypt credentials" },
      { status: 500 },
    );
  }

  try {
    const account = await prisma.account.create({
      data: {
        provider: "imap",
        providerAccountId: email,
        userId,
        type: "credentials",
      },
    });

    await prisma.imapCredential.create({
      data: {
        accountId: account.id,
        imapHost,
        imapPort,
        smtpHost,
        smtpPort,
        username,
        password: encryptedPassword,
      },
    });

    const emailAccount = await prisma.emailAccount.create({
      data: {
        email,
        userId,
        accountId: account.id,
      },
    });

    return NextResponse.json({
      emailAccountId: emailAccount.id,
    } satisfies PostConnectImapResponse);
  } catch (error) {
    if (isDuplicateError(error)) {
      return NextResponse.json(
        { error: "This email account is already linked" },
        { status: 409 },
      );
    }
    throw error;
  }
});
