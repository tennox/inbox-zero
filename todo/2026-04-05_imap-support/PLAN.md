# IMAP Support for Inbox Zero

**Issue:** https://github.com/elie222/inbox-zero/issues/62
**Task dir:** `todo/2026-04-05_imap-support/`

## Context

Users want to use Inbox Zero with their own mail servers (not just Gmail/Outlook). The issue has 30+ upvotes. The codebase already has a well-defined `EmailProvider` interface with Gmail and Outlook implementations. Adding IMAP support means: (1) implementing that interface for IMAP, (2) adding a non-OAuth auth flow for IMAP credentials, and (3) handling 108 `isGoogleProvider`/`isMicrosoftProvider` checks across 43 files.

---

## Architecture Overview

### Current Provider Abstraction
- **Interface:** `apps/web/utils/email/types.ts` — `EmailProvider` with ~60 methods
- **Factory:** `apps/web/utils/email/provider.ts` — `createEmailProvider()` dispatches on `provider` string
- **Implementations:** `apps/web/utils/email/google.ts` (GmailProvider), `apps/web/utils/email/microsoft.ts` (OutlookProvider)
- **Type guards:** `apps/web/utils/email/provider-types.ts` — `isGoogleProvider()`, `isMicrosoftProvider()`
- **Provider name type:** `readonly name: "google" | "microsoft"` (line 223 of types.ts)

### Auth Architecture
- **Framework:** Better Auth (in `apps/web/utils/auth.ts`)
- **OAuth only** — no email/password auth, no IMAP credential storage
- **Token storage:** AES-256-GCM encrypted in `Account` model
- **Account model:** `Account.provider` is `"google"` or `"microsoft"`

---

## Implementation Plan

### Phase 1: Extend the Type System

**Files to modify:**
- `apps/web/utils/email/types.ts` — add `"imap"` to `name` union type
- `apps/web/utils/email/provider-types.ts` — add `isImapProvider()` guard
- `apps/web/utils/email/rate-limit-mode-error.ts` — add IMAP to rate limit metadata
- `apps/web/prisma/schema.prisma` — `Account.provider` must accept `"imap"`

### Phase 2: IMAP Credential Auth Flow

IMAP can't use OAuth (in general). Need a new auth path:

1. **New Prisma fields** on `Account` model for IMAP credentials:
   - `imapHost`, `imapPort`, `smtpHost`, `smtpPort`
   - `imapUsername`, `imapPassword` (encrypted, reusing existing `encryptToken()`/`decryptToken()`)
   - Or: a separate `ImapCredential` model linked to `Account`

2. **New onboarding/linking UI** — form to enter IMAP/SMTP server details + credentials
   - `apps/web/app/api/imap/linking/` — new API routes for credential validation & saving
   - `apps/web/app/(app)/accounts/AddAccount.tsx` — add "IMAP" option alongside Google/Microsoft

3. **Connection validation** — test IMAP connection before saving credentials

4. **Client factory** — `apps/web/utils/email-account-client.ts` needs `getImapClientForEmail()`

### Phase 3: ImapProvider Implementation

**New files:**
- `apps/web/utils/email/imap.ts` — `ImapProvider implements EmailProvider`
- `apps/web/utils/imap/` — directory for IMAP-specific utilities

**Recommended library:** [`imapflow`](https://github.com/postalsys/imapflow) (modern, Promise-based IMAP client) + `nodemailer` (already a dependency) for SMTP/sending.

**Method implementation difficulty by category:**

| Category | Difficulty | Notes |
|----------|-----------|-------|
| getMessage/getMessages | Medium | IMAP FETCH, parse MIME with `mailparser` |
| Thread reconstruction | **Hard** | No native threads — must group by `In-Reply-To`/`References` headers, build thread chains client-side |
| Search | Medium | IMAP SEARCH command; limited vs Gmail's `q` syntax |
| Archive/Move/Delete | Easy | IMAP MOVE/COPY + flag operations |
| Labels | **Hard** | IMAP has flags (system + custom keywords), not labels. Must map to flags or use folders |
| Drafts | Medium | Store in Drafts folder, MIME construction |
| Send email | Easy | SMTP via nodemailer (already a dep) |
| Filters | **Not possible server-side** | IMAP has no filter API. Options: (a) Sieve if server supports it, (b) client-side only via app rules, (c) return empty/stub |
| Watch/Push notifications | **Hard** | IMAP IDLE for real-time, but only watches one folder at a time. Alternative: polling. No equivalent to Gmail historyId |
| Bulk operations | Medium | Loop over messages, no batch API |
| Signatures | **Not available** | IMAP doesn't expose signatures. Return empty |
| Folders | Easy | IMAP LIST command, native folder support |
| Attachments | Medium | Parse MIME parts with BODYSTRUCTURE |

### Phase 4: Sync & Notifications

This is the hardest part. Options:

**Option A: Polling (simplest, recommended for v1)**
- Periodic cron job polls IMAP server for new messages
- Track last-seen UID per folder (`lastSyncedUid` in DB)
- Use IMAP `UIDNEXT` to detect new messages
- Pro: Simple, reliable. Con: Not real-time (1-5 min delay)

**Option B: IMAP IDLE (real-time but complex)**
- Persistent IMAP connection per account
- IDLE only monitors one folder (INBOX)
- Need connection pooling, reconnection logic, keepalive
- Pro: Real-time. Con: Requires persistent server process, one connection per user

**Recommendation:** Start with Option A (polling), add IDLE later.

### Phase 5: Update Provider-Specific Branches

108 occurrences of `isGoogleProvider`/`isMicrosoftProvider` across 43 files need review. Categories:

1. **UI differences** (feature gating, terminology) — ~20 files
   - Many features can be enabled for IMAP or shown with generic labels
   - Some Google/Outlook-specific features should hide for IMAP (e.g., Google Calendar integration)

2. **Provider-boundary code** (auth, linking, watch) — ~10 files
   - Already handled by new IMAP auth flow and sync mechanism

3. **Feature availability** (filters, signatures, folders vs labels) — ~13 files
   - Need `supportsFilters()`, `supportsSignatures()` capability checks on the provider interface
   - Better than hardcoding provider names everywhere

**Recommended approach:** Add a `capabilities` object to `EmailProvider`:
```typescript
readonly capabilities: {
  serverSideFilters: boolean;
  signatures: boolean;
  labels: boolean;       // Gmail-style labels
  folders: boolean;      // Folder-based organization
  pushNotifications: boolean;
  threadApi: boolean;    // Native thread support
  batchApi: boolean;
};
```
Then gradually replace `isGoogleProvider`/`isMicrosoftProvider` checks with capability checks where appropriate.

---

## Scope Assessment

### Minimum Viable IMAP Support (Large effort)
- ~2000-4000 lines of new code for ImapProvider
- ~500-1000 lines for auth/credential flow
- ~200-500 lines for schema changes
- Review/update 43 files with provider checks
- Estimated: **significant multi-week effort** for a single developer

### What Can Be Stubbed/Deferred
- Server-side filters → use app-level rules only
- Signatures → return empty
- Push notifications → polling only for v1
- Calendar integration → skip for IMAP
- Batch operations → sequential fallback

### Key Risks
1. **Thread reconstruction** — most complex part, affects core UX
2. **Connection management** — IMAP connections are stateful (unlike REST APIs)
3. **Server compatibility** — different IMAP servers vary in capability (CONDSTORE, IDLE, MOVE extensions)
4. **Testing** — need real IMAP server for integration tests (Greenmail, Dovecot in Docker)

---

## Verification Plan
1. Unit tests for ImapProvider methods using mock IMAP server
2. Integration tests with Dovecot/Greenmail Docker container
3. Manual test: connect a real IMAP account, verify message listing, send, archive, thread view
4. Verify all 43 files with provider checks handle IMAP gracefully (no crashes, reasonable UX)

---

## Key Files Reference
| File | Purpose |
|------|---------|
| `apps/web/utils/email/types.ts` | EmailProvider interface (60 methods) |
| `apps/web/utils/email/provider.ts` | Provider factory |
| `apps/web/utils/email/google.ts` | Gmail implementation (~85 methods) |
| `apps/web/utils/email/microsoft.ts` | Outlook implementation (~81 methods) |
| `apps/web/utils/email/provider-types.ts` | Provider type guards |
| `apps/web/utils/email-account-client.ts` | OAuth client initialization |
| `apps/web/utils/auth.ts` | Auth config, account linking |
| `apps/web/prisma/schema.prisma` | Database schema |
| `apps/web/utils/email/watch-manager.ts` | Push notification lifecycle |
| `apps/web/app/(app)/accounts/AddAccount.tsx` | Add account UI |
