# Security Notes — IMAP Support

These are known security considerations for the IMAP implementation.
Context: deployment is for trusted friends only, not public SaaS.

## Implemented Mitigations

### SSRF Protection (validation.ts)
- `isPrivateHost()` rejects localhost, RFC-1918, link-local, and IPv6 private ranges
- Applied to both imapHost and smtpHost in the Zod validation schema
- Prevents a user from pointing the server at internal services

### Credential Encryption (ImapCredential.password)
- Uses existing `encryptToken()`/`decryptToken()` (AES-256-GCM via `EMAIL_ENCRYPT_SECRET` + `EMAIL_ENCRYPT_SALT`)
- Passwords encrypted at rest in the database

### Connection Cleanup
- ImapProvider has `close()` method for connection lifecycle
- Validate endpoint uses `finally` block for cleanup
- Sync polling disconnects after each run

### Atomic Account Creation
- `connect` endpoint uses Prisma nested writes (single transaction) to avoid orphaned records

## Known Risks (Acceptable for Trusted Deployment)

### No Rate Limiting on IMAP Linking Endpoints
- `/api/imap/linking/validate` and `/connect` have no brute-force protection
- An attacker could probe IMAP credentials through the validate endpoint
- **Mitigation for production:** Add rate limiting if ever exposed publicly

### IMAP Password Stored Server-Side
- Users provide their IMAP password, which the server stores (encrypted)
- Unlike OAuth, the server holds long-lived credentials
- **Risk:** Server compromise exposes all IMAP passwords
- **Mitigation:** Use app-specific passwords (both Posteo and Migadu support them)

### No TLS Certificate Pinning
- ImapFlow connects with standard TLS validation
- MITM is possible if CA trust is compromised
- Acceptable for trusted network deployment

### DNS Rebinding Not Fully Addressed
- `isPrivateHost()` checks the hostname string, not the resolved IP
- A DNS rebinding attack could bypass SSRF protection
- **Mitigation for production:** Resolve hostname and check IP before connecting

### Poll Endpoint Authentication
- `/api/imap/poll` is protected by `CRON_SECRET` or `INTERNAL_API_KEY`
- If these are weak or leaked, anyone can trigger polling for all accounts

### No Per-Account Connection Limits
- A malicious or misconfigured account could create excessive IMAP connections
- Currently no connection pooling or per-account rate limiting
- Acceptable for small number of trusted users

## Deferred Security Items

### ManageSieve Credential Reuse
- When Sieve support is added, it will reuse the same IMAP credentials
- Sieve port (4190) needs the same SSRF and TLS validation

### Session Token Handling for OIDC
- Better Auth handles OIDC session tokens
- Token rotation and session invalidation should be verified for the OIDC flow
