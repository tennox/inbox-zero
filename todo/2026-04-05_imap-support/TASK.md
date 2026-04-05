# IMAP Support for Inbox Zero

**Issue:** https://github.com/elie222/inbox-zero/issues/62
**Status:** Research Complete — Plan Written

## Description
Add support for generic IMAP email servers, enabling users to connect their own mail servers (not just Gmail/Outlook). The issue has 30+ upvotes and significant community interest.

## Key Findings

### What exists
- Well-defined `EmailProvider` interface with ~60 methods (`apps/web/utils/email/types.ts`)
- Two implementations: `GmailProvider` and `OutlookProvider`
- Clean factory pattern in `createEmailProvider()`
- OAuth-only auth (Better Auth), no password credential storage

### What's needed
1. **ImapProvider** implementing all 60 methods — thread reconstruction is hardest
2. **Non-OAuth auth flow** for IMAP credentials (host/port/user/pass)
3. **Sync mechanism** — polling (v1) or IMAP IDLE (v2)
4. **Update 43 files** with 108 provider-type checks
5. **Capability system** to replace hardcoded provider checks

### Scope
- Multi-week effort, significant undertaking
- Core challenge: IMAP has no threads, no batch API, no server-side filters, no push notifications
- Recommended libs: `imapflow` + `nodemailer` (already a dep)

## Progress Notes
- 2026-04-05: Task created, codebase exploration complete, plan written
