-- CreateTable
CREATE TABLE "ImapCredential" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL DEFAULT 993,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "sieveHost" TEXT,
    "sievePort" INTEGER DEFAULT 4190,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImapCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImapSyncState" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "folder" TEXT NOT NULL DEFAULT 'INBOX',
    "lastUid" INTEGER,
    "lastModseq" TEXT,
    "uidValidity" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImapSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImapCredential_accountId_key" ON "ImapCredential"("accountId");

-- CreateIndex
CREATE INDEX "ImapSyncState_emailAccountId_idx" ON "ImapSyncState"("emailAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ImapSyncState_emailAccountId_folder_key" ON "ImapSyncState"("emailAccountId", "folder");

-- AddForeignKey
ALTER TABLE "ImapCredential" ADD CONSTRAINT "ImapCredential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImapSyncState" ADD CONSTRAINT "ImapSyncState_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
