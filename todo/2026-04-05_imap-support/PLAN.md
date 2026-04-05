# IMAP Support for Inbox Zero — Implementation Plan

**Issue:** https://github.com/elie222/inbox-zero/issues/62
**Task dir:** `todo/2026-04-05_imap-support/`
**User context:** Self-hosting for friends with Posteo & Migadu accounts. OIDC via Kanidm. Open source only.

## Context

Adding IMAP provider support so self-hosters can use Inbox Zero with any IMAP mail server. Both target providers (Posteo, Migadu) have excellent IMAP support: THREAD=REFERENCES, IDLE, CONDSTORE/QRESYNC, MOVE, SORT, NOTIFY.

**MVP scope:** AI auto-triage rules (categorize, archive, move-to-folder), bulk operations (archive/unsubscribe), cold email detection, email stats. No drafting, no reply tracker, no AI chat for v1.

**Label strategy:** Database-first (labels stored in app DB, the `Label` model). Best-effort sync to IMAP keywords as optimization. Folder-move as optional user action.

---

## Phase 0: Make Google/Outlook Optional for Self-Hosting

### `apps/web/env.ts`
- Line 65: `GOOGLE_CLIENT_ID` → `z.string().optional()`
- Line 66: `GOOGLE_CLIENT_SECRET` → `z.string().optional()`
- Line 148: `GOOGLE_PUBSUB_TOPIC_NAME` → `z.string().optional()`
- Add new env vars:
  - `IMAP_ENABLED`: `booleanString.optional().default(false)`
  - `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ISSUER_URL`, `OIDC_PROVIDER_ID`: optional strings
- Note: `INTERNAL_API_KEY`, `EMAIL_ENCRYPT_SECRET`, `EMAIL_ENCRYPT_SALT` stay required (needed for IMAP too)

### `apps/web/utils/auth.ts`
- Wrap `googleSocialProvider` in `GOOGLE_CLIENT_ID` check (line 55-68, mostly done already)
- Add OIDC to `genericOauthConfig` array (line 81-117) when `OIDC_*` env vars present:
  ```typescript
  ...(env.OIDC_ISSUER_URL ? [{
    providerId: env.OIDC_PROVIDER_ID || "oidc",
    discoveryUrl: `${env.OIDC_ISSUER_URL}/.well-known/openid-configuration`,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    scopes: ["openid", "profile", "email"],
    pkce: true,
  }] : []),
  ```
- Line 208: Add OIDC provider ID to `trustedProviders`
- **`handleLinkAccount()` (line 480):** Add early return for IMAP + unknown providers:
  ```typescript
  // IMAP accounts are linked via credential form, not OAuth
  if (!isGoogleProvider(account.providerId) && !isMicrosoftProvider(account.providerId)) {
    // For OIDC login accounts, EmailAccount is created separately during IMAP linking
    await prisma.account.update({ where: { id: account.id }, data: { disconnectedAt: null } });
    return;
  }
  ```
- **`getProfileData()` (line 422):** Already returns undefined for unknown providers → `handleLinkAccount` guard above prevents this from being called

### `apps/web/app/(landing)/login/LoginForm.tsx`
- Add OIDC sign-in button when configured (pass `useOidcProvider` prop from server component)
- Use existing `signInWithOauth2({ providerId: "oidc" })` — already supported

### `apps/web/app/(landing)/login/page.tsx`
- Pass new `useOidcProvider` prop based on env var presence

---

## Phase 1: Type System & Schema

### `apps/web/utils/email/types.ts`
- Line 223: `readonly name: "google" | "microsoft"` → `"google" | "microsoft" | "imap"`
- Line 115: `getFolders(): Promise<OutlookFolder[]>` → `Promise<EmailFolder[]>` (rename type)
- Add `EmailFolder` type (same shape as OutlookFolder but generic name):
  ```typescript
  export interface EmailFolder {
    id: string;
    displayName: string;
    childFolders: EmailFolder[];
    childFolderCount?: number;
  }
  ```
- Update `OutlookFolder` imports throughout to use `EmailFolder` (or keep OutlookFolder as alias)

### `apps/web/utils/email/provider-types.ts`
- Add `isImapProvider()` type guard
- Add `isApiBasedProvider()` (google|microsoft) for feature gating

### `apps/web/utils/email/rate-limit-mode-error.ts`
- Add `"imap"` to `EmailProviderRateLimitProvider` type
- Add entry in `EMAIL_PROVIDER_RATE_LIMIT_METADATA` (pro-forma — IMAP servers rarely rate-limit)
- Update `toRateLimitProvider()` to accept `"imap"`

### `apps/web/prisma/schema.prisma`

**New model — ImapCredential:**
```prisma
model ImapCredential {
  id        String  @id @default(cuid())
  accountId String  @unique
  account   Account @relation(fields: [accountId], references: [id], onDelete: Cascade)

  imapHost  String
  imapPort  Int     @default(993)
  smtpHost  String
  smtpPort  Int     @default(587)
  username  String
  password  String  @db.Text  // encrypted via encryptToken()

  sieveHost String?
  sievePort Int?    @default(4190)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

**New model — ImapSyncState** (instead of overloading lastSyncedHistoryId):
```prisma
model ImapSyncState {
  id             String @id @default(cuid())
  emailAccountId String
  emailAccount   EmailAccount @relation(fields: [emailAccountId], references: [id], onDelete: Cascade)

  folder         String @default("INBOX")
  lastUid        Int?
  lastModseq     String?   // BigInt as string (MODSEQ can exceed JS Number range)
  uidValidity    Int?      // Track UIDVALIDITY — if it changes, full resync needed

  updatedAt      DateTime @updatedAt

  @@unique([emailAccountId, folder])
}
```

**Add relations:**
- `Account`: add `imapCredential ImapCredential?`
- `EmailAccount`: add `imapSyncStates ImapSyncState[]`

**Encryption:** Extend `apps/web/prisma/prisma-extensions.ts` to encrypt/decrypt `ImapCredential.password` (same pattern as Account.access_token/refresh_token)

---

## Phase 2: IMAP Client Infrastructure

### Install dependencies
```bash
cd apps/web && pnpm add imapflow mailparser && pnpm add -D @types/mailparser
```

### `apps/web/utils/imap/client.ts` — Connection factory
```typescript
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";

export async function createImapClient(emailAccountId: string): Promise<ImapFlow>
export async function createSmtpTransport(emailAccountId: string): Promise<Transporter>
```
- Fetch ImapCredential from DB, decrypt password
- Create ImapFlow with `{ host, port, secure: true, auth: { user, pass } }`
- **Critical:** All operations use `{uid: true}` mode — create wrapper helpers
- Return client with detected capabilities (check `client.capabilities` after connect)

### `apps/web/utils/imap/uid-helpers.ts` — UID-safe wrappers
```typescript
// All fetch/search/store operations must use UIDs, not sequence numbers
// ImapFlow defaults to sequence numbers unless {uid: true} is passed
export async function fetchByUid(client: ImapFlow, range: string, fields: object)
export async function searchByUid(client: ImapFlow, criteria: object): Promise<number[]>
export async function storeByUid(client: ImapFlow, range: string, flags: object)
```

### `apps/web/utils/email-account-client.ts`
- Add `getImapClientForEmail({ emailAccountId, logger })` function

### `apps/web/utils/email/provider.ts`
- Add `"imap"` case in `createEmailProvider()`:
  ```typescript
  if (rateLimitProvider === "imap") {
    const { createImapClient } = await import("@/utils/imap/client");
    const client = await createImapClient(emailAccountId);
    return new ImapProvider(client, logger, emailAccountId);
  }
  ```

---

## Phase 3: ImapProvider Core

### `apps/web/utils/email/imap.ts` — `ImapProvider implements EmailProvider`

### Thread ID Strategy (addressing review concern)
- Use the **root Message-ID from the `References` header chain** as the thread ID
- When IMAP THREAD command returns a thread group, fetch the `References` header of first message, extract the oldest Message-ID as thread root
- If no References header, use the message's own Message-ID
- Store thread membership in the existing `EmailMessage` table (`threadId` column already exists)
- **UIDVALIDITY handling:** On each connection, compare current UIDVALIDITY with stored value in ImapSyncState. If changed, trigger full resync of that folder.

### `ParsedMessage` field mapping for IMAP
- `id`: String(UID) — use UID as message identifier
- `threadId`: Root Message-ID from References chain
- `historyId`: String(MODSEQ) if CONDSTORE available, else "0"
- `labelIds`: Map from IMAP flags/keywords → app label IDs
- `internalDate`: IMAP INTERNALDATE (maps directly)
- `snippet`: Use SNIPPET=FUZZY (both servers support PREVIEW)
- `headers`: Parsed from IMAP ENVELOPE + HEADER fetch
- `parentFolderId`: Current mailbox name

### Utility files under `apps/web/utils/imap/`:
- `thread.ts` — IMAP THREAD command, thread ID resolution from References
- `message.ts` — FETCH + mailparser, construct ParsedMessage
- `folder.ts` — SPECIAL-USE detection (Archive, Trash, Junk, Sent, Drafts), folder CRUD
- `search.ts` — Query → IMAP SEARCH criteria translation
- `flags.ts` — Flag/keyword management, mapping to app labels

### Methods: Implement vs Stub

**Implement (MVP):**
getMessage, getMessagesBatch, getThread, getThreadMessages, getThreads, getThreadsWithQuery, getMessagesWithPagination, getMessagesFromSender, getInboxMessages, getSentMessages, getInboxStats, archiveThread, archiveThreadWithLabel, archiveMessage, trashThread, markRead, markReadThread, markSpam, moveThreadToFolder, labelMessage, createLabel, getLabels, getLabelById, getLabelByName, getOrCreateInboxZeroLabel, removeThreadLabel, removeThreadLabels, bulkArchiveFromSenders, bulkTrashFromSenders, searchMessages, hasPreviousCommunicationsWithSenderOrDomain, countReceivedMessages, getFolders, getOrCreateFolderIdByName, blockUnsubscribedEmail, isReplyInThread, isSentMessage, toJSON, name

**Stub (not in MVP):**
- `watchEmails()` → return null
- `unwatchEmails()` → no-op
- `processHistory()` → no-op (polling replaces)
- `createAutoArchiveFilter/createFilter/getFiltersList/deleteFilter` → no-op / empty
- `getSignatures()` → return []
- `sendEmail/sendEmailWithHtml/replyToEmail/forwardEmail` → implement basic SMTP (useful even for MVP — forward rule)
- `draftEmail/createDraft/getDraft/getDrafts/updateDraft/deleteDraft/sendDraft` → throw not supported
- `getAttachment()` → implement (needed for filing detection)
- `checkIfReplySent()` → SEARCH Sent folder
- `getAccessToken()` → return ""

---

## Phase 4: IMAP Account Linking UI & API

### `apps/web/app/api/imap/linking/validate/route.ts` — POST
- Accept: `{ imapHost, imapPort, smtpHost, smtpPort, username, password, email }`
- Validate with Zod schema
- Test IMAP: connect → login → list INBOX → disconnect
- Test SMTP: verify → disconnect
- Return `{ success: true }` or error details

### `apps/web/app/api/imap/linking/connect/route.ts` — POST
- Requires authenticated session
- Encrypt password using `encryptToken()`
- Create Account record: `provider: "imap"`, `providerAccountId: email`
- Create ImapCredential record linked to Account
- Create EmailAccount record
- Return emailAccountId

### `apps/web/app/(app)/accounts/AddAccount.tsx`
- Add "IMAP" tab alongside Google/Microsoft
- Form fields: email, IMAP host, IMAP port, SMTP host, SMTP port, username, password
- "Test Connection" → validate endpoint
- "Connect" → connect endpoint
- Conditionally show based on `IMAP_ENABLED` env var (exposed via NEXT_PUBLIC or server component)

---

## Phase 5: Polling Sync

### `apps/web/utils/imap/sync.ts`
```typescript
export async function pollImapAccount(emailAccountId: string, logger: Logger): Promise<void>
```

Strategy:
1. Connect to IMAP, SELECT INBOX
2. Check UIDVALIDITY against stored ImapSyncState
   - If changed: clear sync state, trigger full resync
3. If CONDSTORE available:
   - FETCH changes since last MODSEQ (CHANGEDSINCE modifier)
   - Track MODSEQ per-folder in ImapSyncState
4. Else:
   - SEARCH UID `lastUid+1:*` for new messages
5. For each new/changed message:
   - Fetch full message
   - Parse to `ParsedMessage`
   - Feed into `processHistoryItem` pipeline (existing, provider-agnostic)
6. Update ImapSyncState (lastUid, lastModseq, uidValidity)
7. Disconnect

### `apps/web/app/api/imap/poll/route.ts` — Cron endpoint
- Iterate all IMAP email accounts (where account.provider = "imap" AND account.disconnectedAt IS NULL)
- Poll each one sequentially (or with bounded concurrency)
- Protected by CRON_SECRET or INTERNAL_API_KEY

### Watch Manager integration
- `apps/web/utils/email/watch-manager.ts` — `getEmailAccountsToWatch()` (line 37):
  Add filter: `account: { provider: { not: "imap" } }` to Prisma where clause

---

## Phase 6: Must-Fix Provider Checks

These files will crash or behave incorrectly for IMAP users:

| File | Issue | Fix |
|------|-------|-----|
| `utils/actions/permissions.ts:76-77` | Throws "Unsupported provider" | Add IMAP case: return `{ hasAllPermissions: true, hasRefreshToken: true }` |
| `utils/actions/clean.ts:40` | Google-only gate | Allow IMAP (IMAP SEARCH by date works fine) |
| `utils/email/watch-manager.ts` | Polls all accounts for watch setup | Filter out IMAP at query level |
| `providers/EmailProvider.tsx` | Uses isGoogleProvider for label colors | Add IMAP fallback (default colors) |
| `app/api/user/folders/route.ts` | Rejects non-Microsoft | Allow IMAP (getFolders works natively) |
| `utils/terminology.ts` | Provider-specific terms | Add IMAP defaults |
| `utils/account-linking.ts` | OAuth-specific linking flow | Add IMAP path |
| `components/SideNav.tsx` | Feature gating by provider | Add IMAP awareness |
| `app/(app)/[emailAccountId]/permissions/consent/page.tsx` | OAuth permissions page | Skip/redirect for IMAP |

---

## Implementation Order & Subagent Decomposition

### Workstream A: Foundation (sequential, blocks everything)
1. Phase 0: env.ts changes (make Google optional)
2. Phase 0: auth.ts changes (OIDC config, handleLinkAccount guard)
3. Phase 1: Type system (types.ts, provider-types.ts, rate-limit)
4. Phase 1: Schema (ImapCredential, ImapSyncState models)
5. Prisma migration: generate + apply

### Workstream B: IMAP Core (after A complete)
6. Phase 2: Install deps, IMAP client factory, UID helpers
7. Phase 3: ImapProvider — message/thread/folder methods
8. Phase 3: ImapProvider — search/label/bulk methods
9. Phase 3: ImapProvider — stub methods + SMTP send

### Workstream C: UI & Linking (after A complete, parallel with B)
10. Phase 4: IMAP linking API routes (validate + connect)
11. Phase 4: AddAccount.tsx IMAP form
12. Phase 0: LoginForm OIDC button

### Workstream D: Sync (after B complete)
13. Phase 5: Polling sync logic
14. Phase 5: Poll cron endpoint

### Workstream E: Provider Check Fixes (after B, parallel with D)
15. Phase 6: Must-fix provider checks (permissions, clean, watch-manager, etc.)

---

## Verification Plan

1. App starts with IMAP-only env (no GOOGLE_CLIENT_ID)
2. OIDC login works via Kanidm
3. IMAP account links via credential form (connection validated)
4. Thread listing from INBOX (using IMAP THREAD=REFERENCES)
5. Message read (full MIME parse, headers, body, snippets)
6. Archive thread (MOVE to Archive folder)
7. Label message (IMAP keyword + DB label)
8. Search by sender
9. AI rule processes new email (via polling)
10. Bulk archive from sender
11. All major UI pages load without crash for IMAP accounts
12. No regressions for Google/Outlook providers

---

## Key Files

| File | Phase |
|------|-------|
| `apps/web/env.ts` | 0 |
| `apps/web/utils/auth.ts` | 0 |
| `apps/web/app/(landing)/login/LoginForm.tsx` | 0 |
| `apps/web/utils/email/types.ts` | 1 |
| `apps/web/utils/email/provider-types.ts` | 1 |
| `apps/web/utils/email/rate-limit-mode-error.ts` | 1 |
| `apps/web/prisma/schema.prisma` | 1 |
| `apps/web/utils/imap/client.ts` | 2 (NEW) |
| `apps/web/utils/imap/uid-helpers.ts` | 2 (NEW) |
| `apps/web/utils/email-account-client.ts` | 2 |
| `apps/web/utils/email/provider.ts` | 2 |
| `apps/web/utils/email/imap.ts` | 3 (NEW) |
| `apps/web/utils/imap/thread.ts` | 3 (NEW) |
| `apps/web/utils/imap/message.ts` | 3 (NEW) |
| `apps/web/utils/imap/folder.ts` | 3 (NEW) |
| `apps/web/utils/imap/search.ts` | 3 (NEW) |
| `apps/web/utils/imap/flags.ts` | 3 (NEW) |
| `apps/web/app/api/imap/linking/validate/route.ts` | 4 (NEW) |
| `apps/web/app/api/imap/linking/connect/route.ts` | 4 (NEW) |
| `apps/web/app/(app)/accounts/AddAccount.tsx` | 4 |
| `apps/web/utils/imap/sync.ts` | 5 (NEW) |
| `apps/web/app/api/imap/poll/route.ts` | 5 (NEW) |
| `apps/web/utils/actions/permissions.ts` | 6 |
| `apps/web/utils/actions/clean.ts` | 6 |
| `apps/web/utils/email/watch-manager.ts` | 6 |
