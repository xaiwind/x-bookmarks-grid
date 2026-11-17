import { t, tr } from "./i18n.js";

// Backup file format for moving the library between installs. A backup never contains post bodies.

export const BACKUP_FORMAT = "x-bookmark-library-backup";
export const BACKUP_VERSION = 1;
const MAX_BACKUP_LENGTH = 200_000_000;

/**
 * @param {object[]} records every stored record, including hidden ones
 * @param {Date} [exportedAt]
 * @returns {string} JSON text
 */
export function buildBackup(records, exportedAt = new Date()) {
  const clean = records.filter((record) => isValidId(record?.id)).map((record) => ({ ...record, text: "" }));
  return JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: exportedAt.toISOString(), count: clean.length, records: clean });
}

/**
 * Validates a backup file. The file is untrusted input: anything that is not a plain record
 * with a numeric post id is dropped.
 * @param {string} text
 * @returns {{ records: object[], skipped: number, exportedAt: string }}
 */
export function parseBackup(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error(t("备份文件是空的。"));
  if (text.length > MAX_BACKUP_LENGTH) throw new Error(t("备份文件太大，无法导入。"));
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(t("这不是有效的备份文件（不是 JSON）。"));
  }
  if (data?.format !== BACKUP_FORMAT || !Array.isArray(data.records)) throw new Error(t("这不是本插件导出的备份文件。"));
  if (Number(data.version) > BACKUP_VERSION) throw new Error(t("备份文件来自更新的版本，请先升级插件。"));
  const byId = new Map();
  for (const item of data.records) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !isValidId(item.id)) continue;
    byId.set(String(item.id), sanitizeRecord(item));
  }
  return { records: [...byId.values()], skipped: data.records.length - byId.size, exportedAt: String(data.exportedAt || "") };
}

/**
 * Importing only fills gaps: whatever the library already has is kept.
 * @param {object | undefined} existing
 * @param {object} incoming
 */
export function mergeBackupRecord(existing, incoming) {
  if (!existing) return incoming;
  const kept = Object.fromEntries(Object.entries(existing).filter(([, value]) => hasValue(value)));
  return { ...incoming, ...kept };
}

function sanitizeRecord(item) {
  const url = /^https:\/\/(x|twitter)\.com\//.test(String(item.url || "")) ? String(item.url) : "";
  const images = Array.isArray(item.imageUrls) ? item.imageUrls.filter((value) => /^https:\/\/pbs\.twimg\.com\//.test(String(value))).map(String) : [];
  const links = Array.isArray(item.externalUrls) ? item.externalUrls.filter((value) => /^https?:\/\//.test(String(value))).map(String) : [];
  return { ...item, id: String(item.id), url, imageUrls: images, externalUrls: links, text: "" };
}

function isValidId(value) {
  return /^\d{1,30}$/.test(String(value ?? ""));
}

function hasValue(value) {
  if (value === undefined || value === null || value === "") return false;
  return !(Array.isArray(value) && value.length === 0);
}
