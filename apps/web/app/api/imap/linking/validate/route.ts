import { NextResponse } from "next/server";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { withAuth } from "@/utils/middleware";
import { imapConnectionSchema } from "@/utils/imap/validation";

export type PostValidateImapResponse = { success: true };

export const POST = withAuth("imap/linking/validate", async (request) => {
  const body = await request.json();
  const parsed = imapConnectionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }

  const { imapHost, imapPort, smtpHost, smtpPort, username, password } =
    parsed.data;

  // Test IMAP connection
  const imapClient = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: true,
    auth: { user: username, pass: password },
    logger: false,
  });

  try {
    await imapClient.connect();
    await imapClient.list();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "IMAP connection failed";
    return NextResponse.json(
      { error: `IMAP connection failed: ${message}` },
      { status: 400 },
    );
  } finally {
    try {
      await imapClient.logout();
    } catch {
      // best-effort cleanup
    }
  }

  // Test SMTP connection
  const smtpTransport = createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: username, pass: password },
  });

  try {
    await smtpTransport.verify();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "SMTP connection failed";
    return NextResponse.json(
      { error: `SMTP connection failed: ${message}` },
      { status: 400 },
    );
  } finally {
    smtpTransport.close();
  }

  return NextResponse.json({
    success: true,
  } satisfies PostValidateImapResponse);
});
