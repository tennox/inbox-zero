# Orchestration Notes

## Subagent Brief Template
- Context: @TASK.md, @PLAN.md section [X], relevant files
- Requirements: specific, verifiable
- Boundaries: in-scope files, out-of-scope, report-for-orchestrator policy
- Verify: validation command to run
- If unclear: exit and report back with specific question

## Review Signals
- "I also fixed..." → scope creep, investigate
- "I assumed..." → verify correctness
- "I couldn't find..." → insufficient context

## Validation
- `cd apps/web && pnpm exec tsc --noEmit` — type check (but may have pre-existing errors)
- `pnpm --filter inbox-zero-ai build:ci` — CI-aligned type/build check
- `pnpm test` — run tests

## Progress

### Workstream A: Foundation (sequential)
- [x] A1: Phase 0 — env.ts (make Google optional)
- [x] A2: Phase 0 — auth.ts (OIDC config, handleLinkAccount guard)
- [x] A3: Phase 1 — Type system (types.ts, provider-types.ts, rate-limit)
- [x] A4: Phase 1 — Schema (ImapCredential, ImapSyncState, EmailFolder rename)
- [x] A5: Prisma migration generate

### Workstream B: IMAP Core (after A)
- [x] B1: Phase 2 — Install deps, client factory, UID helpers
- [x] B2-B4: Phase 3 — ImapProvider (1542 lines, ~45 methods implemented, ~11 stubbed)

### Workstream C: UI & Linking (after A, parallel with B)
- [x] C1: Phase 4 — IMAP linking API routes (validate + connect)
- [x] C2: Phase 4 — AddAccount.tsx IMAP form
- [x] C3: Phase 0 — LoginForm OIDC button

### Workstream D: Sync (after B)
- [x] D1: Phase 5 — Polling sync + cron endpoint (processHistoryItem fully wired)

### Workstream E: Provider Check Fixes (after B, parallel with D)
- [x] E1: Phase 6 — Must-fix provider checks (permissions, clean, watch-manager, provider factory, terminology)

## Key Decisions (for subagent consistency)
- **Library:** imapflow for IMAP, nodemailer for SMTP, mailparser for MIME
- **Thread ID:** Root Message-ID from References header chain
- **UIDs:** Always use `{uid: true}` with ImapFlow — never sequence numbers
- **Labels:** Database-first (Label model), best-effort IMAP keyword sync
- **Encryption:** Use existing encryptToken()/decryptToken() for IMAP passwords
- **Folders:** Use SPECIAL-USE flags to detect Archive/Trash/Sent/Drafts/Junk
- **Provider name:** `"imap"` string literal throughout
