import { getStorage, setStorage } from "./chrome-storage.js";
import { mergeLibraryEntries } from "./bookmark-repository.js";
import { mergeBackupRecord, parseBackup } from "../src/backup-core.js";

const BUNDLED_BACKUP_PATH = "migration/library-backup.json";
const IMPORT_FLAG = "bundledBackupImportedAt";

/**
 * Restores the library from a backup file placed in the extension folder, once.
 * This is how the library follows the extension when its folder (and therefore its identity
 * in Chrome) changed. It only fills gaps and never removes anything.
 * @returns {Promise<{ imported: number }>}
 */
export async function importBundledBackupOnce() {
  const stored = await getStorage([IMPORT_FLAG]);
  if (stored[IMPORT_FLAG]) return { imported: 0 };
  let text;
  try {
    const response = await fetch(chrome.runtime.getURL(BUNDLED_BACKUP_PATH));
    if (!response.ok) return { imported: 0 };
    text = await response.text();
  } catch {
    // No bundled backup in this install; nothing to restore.
    return { imported: 0 };
  }
  const backup = parseBackup(text);
  const saved = await mergeLibraryEntries(backup.records, mergeBackupRecord);
  await setStorage({ [IMPORT_FLAG]: new Date().toISOString() });
  return { imported: saved.added };
}
