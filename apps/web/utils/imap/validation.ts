import { z } from "zod";

export const imapConnectionSchema = z.object({
  email: z.string().email(),
  imapHost: z.string().min(1),
  imapPort: z.coerce.number().int().min(1).max(65_535).default(993),
  smtpHost: z.string().min(1),
  smtpPort: z.coerce.number().int().min(1).max(65_535).default(587),
  username: z.string().min(1),
  password: z.string().min(1),
});
