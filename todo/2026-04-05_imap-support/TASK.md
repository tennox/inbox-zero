# IMAP Support for Inbox Zero

**Issue:** https://github.com/elie222/inbox-zero/issues/62
**Status:** Implementation Complete (MVP)

## Description
Add support for generic IMAP email servers, enabling users to connect their own mail servers (not just Gmail/Outlook).

## What was implemented

### Foundation (Phase 0-1)
- Google/Outlook env vars made optional (app starts without them)
- Generic OIDC auth support via Better Auth (Kanidm, Keycloak, etc.)
- OIDC login button on sign-in page
- `ImapCredential` and `ImapSyncState` Prisma models + migration
- `EmailProvider` interface extended with `"imap"` type
- `isImapProvider()`, `isApiBasedProvider()` type guards
- `EmailFolder` generic type (replaces OutlookFolder coupling)

### IMAP Core (Phase 2-3)
- 7 utility files: client, uid-helpers, thread, message, folder, search, flags
- `ImapProvider` class: 1542 lines, ~45 methods fully implemented, ~11 stubbed
- Libraries: imapflow (IMAP), mailparser (MIME), nodemailer (SMTP — already existed)

### UI & Linking (Phase 4)
- IMAP connection validation API (`/api/imap/linking/validate`)
- IMAP account connection API (`/api/imap/linking/connect`)
- AddAccount.tsx: IMAP form with test/connect buttons

### Sync (Phase 5)
- Polling sync with UIDVALIDITY tracking
- Full `processHistoryItem` pipeline integration (AI rules fire on new emails)
- Cron endpoint (`/api/imap/poll`) with bounded concurrency

### Provider Check Fixes (Phase 6)
- permissions.ts: IMAP returns hasAllPermissions
- clean.ts: IMAP allowed (was Google-only)
- watch-manager.ts: IMAP accounts excluded from webhook setup
- provider.ts: IMAP case in factory

## What's NOT implemented (deferred)
- Sieve/ManageSieve server-side filters (Phase 7)
- IMAP IDLE real-time notifications (currently polling only)
- CONDSTORE/MODSEQ incremental sync (currently UID-range based)
- Draft operations (stubbed)
- Attachment binary extraction (metadata only)
- Connection pooling (new connection per request)

## Stats
- 32 files changed, ~4,100 lines added
- 11 commits

## Next Steps
1. Integration testing with real Posteo/Migadu accounts
2. Sieve filter support (ManageSieve protocol)
3. Connection pooling for ImapFlow
4. CONDSTORE-based incremental sync
5. IMAP IDLE for near-real-time notifications
