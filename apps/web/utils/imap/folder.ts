import type { ImapFlow } from "imapflow";
import type { EmailFolder } from "@/utils/email/types";

export interface SpecialFolders {
  archive: string | null;
  drafts: string | null;
  inbox: string;
  junk: string | null;
  sent: string | null;
  trash: string | null;
}

/** Well-known folder name patterns for servers without SPECIAL-USE */
const WELL_KNOWN_NAMES: Record<keyof Omit<SpecialFolders, "inbox">, RegExp[]> =
  {
    archive: [/^archive$/i, /^archived$/i, /^all mail$/i, /^allmail$/i],
    trash: [/^trash$/i, /^deleted$/i, /^deleted items$/i, /^bin$/i],
    sent: [/^sent$/i, /^sent items$/i, /^sent mail$/i, /^sentmail$/i],
    drafts: [/^drafts$/i, /^draft$/i],
    junk: [/^junk$/i, /^spam$/i, /^junk mail$/i, /^junk e-mail$/i],
  };

/**
 * Maps IMAP SPECIAL-USE flags to our SpecialFolders keys.
 * ImapFlow normalises them to lowercase with leading backslash.
 */
const SPECIAL_USE_MAP: Record<string, keyof SpecialFolders> = {
  "\\archive": "archive",
  "\\trash": "trash",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\junk": "junk",
  "\\inbox": "inbox",
};

/**
 * Detects Archive, Trash, Sent, Drafts, and Junk folders by inspecting
 * SPECIAL-USE flags first, then falling back to well-known folder names.
 */
export async function getSpecialUseFolders(
  client: ImapFlow,
): Promise<SpecialFolders> {
  const folders = await client.list();

  const result: SpecialFolders = {
    inbox: "INBOX",
    archive: null,
    trash: null,
    sent: null,
    drafts: null,
    junk: null,
  };

  // First pass: use SPECIAL-USE flags
  for (const folder of folders) {
    if (!folder.specialUse) continue;
    const key = SPECIAL_USE_MAP[folder.specialUse.toLowerCase()];
    if (key && key !== "inbox") {
      result[key] = folder.path;
    }
  }

  // Second pass: name-based detection for any slots not filled
  for (const folder of folders) {
    const name = folder.name;

    for (const [key, patterns] of Object.entries(WELL_KNOWN_NAMES) as [
      keyof typeof WELL_KNOWN_NAMES,
      RegExp[],
    ][]) {
      if (result[key] !== null) continue; // already found via SPECIAL-USE
      if (patterns.some((re) => re.test(name))) {
        result[key] = folder.path;
      }
    }
  }

  return result;
}

/**
 * Lists all mailbox folders as an EmailFolder tree.
 * Uses ImapFlow's list() which returns a flat list; we reconstruct the hierarchy
 * using the delimiter.
 */
export async function listFolders(client: ImapFlow): Promise<EmailFolder[]> {
  const folders = await client.list();

  // Build a path→node map
  const nodeMap = new Map<string, EmailFolder>();
  for (const folder of folders) {
    nodeMap.set(folder.path, {
      id: folder.path,
      displayName: folder.name,
      childFolders: [],
    });
  }

  const roots: EmailFolder[] = [];

  for (const folder of folders) {
    const node = nodeMap.get(folder.path);
    if (!node) continue;

    if (folder.parentPath && nodeMap.has(folder.parentPath)) {
      nodeMap.get(folder.parentPath)!.childFolders.push(node);
    } else {
      roots.push(node);
    }
  }

  // Populate childFolderCount
  for (const folder of folders) {
    const node = nodeMap.get(folder.path);
    if (node) {
      node.childFolderCount = node.childFolders.length;
    }
  }

  return roots;
}

/**
 * Ensures a mailbox folder exists, creating it if necessary.
 * Returns the full path of the folder.
 */
export async function ensureFolderExists(
  client: ImapFlow,
  name: string,
): Promise<string> {
  const folders = await client.list();
  const existing = folders.find(
    (f) => f.path === name || f.name.toLowerCase() === name.toLowerCase(),
  );

  if (existing) {
    return existing.path;
  }

  const result = await client.mailboxCreate(name);
  return result.path;
}
