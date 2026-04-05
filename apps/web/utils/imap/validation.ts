import { z } from "zod";

function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase();
  // Reject localhost variants
  if (lower === "localhost" || lower === "localhost.localdomain") return true;
  // Reject IPv4 private/reserved ranges
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (host === "0.0.0.0") return true;
  // Reject IPv6 loopback and private
  if (
    host === "::1" ||
    host.startsWith("fc00:") ||
    host.startsWith("fd00:") ||
    host.startsWith("fe80:")
  )
    return true;
  return false;
}

export const imapConnectionSchema = z.object({
  email: z.string().email(),
  imapHost: z
    .string()
    .min(1)
    .refine((h) => !isPrivateHost(h), {
      message: "Private/reserved hosts are not allowed",
    }),
  imapPort: z.coerce.number().int().min(1).max(65_535).default(993),
  smtpHost: z
    .string()
    .min(1)
    .refine((h) => !isPrivateHost(h), {
      message: "Private/reserved hosts are not allowed",
    }),
  smtpPort: z.coerce.number().int().min(1).max(65_535).default(587),
  username: z.string().min(1),
  password: z.string().min(1),
});
