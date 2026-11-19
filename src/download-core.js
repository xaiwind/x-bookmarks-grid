import { t } from "./i18n.js";

// Decides where a downloaded post goes (a folder the user picked, or the browser's downloads),
// remembers which posts were downloaded, and what to do when one is downloaded again.

export const DOWNLOAD_MODES = Object.freeze(["ask", "folder", "browser"]);
export const DUPLICATE_ACTIONS = Object.freeze(["ask", "overwrite", "copy"]);
export const DOWNLOAD_PREFS_KEY = "downloadPrefs";
const MAX_COPY_NUMBER = 999;
const UNKNOWN_AUTHOR = "unknown";

/**
 * @typedef {{ mode: "ask" | "folder" | "browser", byAuthor: boolean, duplicate: "ask" | "overwrite" | "copy", saveMedia: boolean }} DownloadPrefs
 */

/** @param {unknown} raw stored value @returns {DownloadPrefs} */
export function normalizeDownloadPrefs(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    mode: DOWNLOAD_MODES.includes(value.mode) ? value.mode : "ask",
    byAuthor: value.byAuthor === true,
    duplicate: DUPLICATE_ACTIONS.includes(value.duplicate) ? value.duplicate : "ask",
    // Photos and videos are saved next to the note unless the user turned it off.
    saveMedia: value.saveMedia !== false,
  };
}

/**
 * @param {{ prefs: { mode: string }, hasFolder: boolean, canPick: boolean }} state
 * @returns {"ask" | "folder" | "browser"}
 */
export function resolveDownloadTarget({ prefs, hasFolder, canPick }) {
  if (!canPick || prefs.mode === "browser") return "browser";
  if (prefs.mode === "folder" && hasFolder) return "folder";
  return "ask";
}

/** @param {unknown} author X handle @returns {string} a folder name safe on every system */
export function authorFolderName(author) {
  const name = String(author || "")
    .replace(/^@+/, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return name || UNKNOWN_AUTHOR;
}

/**
 * @param {{ author?: string }} record
 * @param {string} filename
 * @param {{ byAuthor?: boolean }} [prefs]
 * @returns {string} path relative to the chosen folder
 */
export function buildDownloadPath(record, filename, { byAuthor = false } = {}) {
  return byAuthor ? `${authorFolderName(record.author)}/${filename}` : filename;
}

/** @param {string} folderName @param {string} relativePath @returns {string} */
export function formatSavedLocation(folderName, relativePath) {
  return [folderName, ...relativePath.split("/")].filter(Boolean).join(" / ");
}

/** @param {{ downloadedAt?: string }} record @returns {boolean} */
export function isDownloaded(record) {
  return Boolean(record?.downloadedAt);
}

/**
 * What to do when the user downloads a post.
 * @param {{ prefs: DownloadPrefs, record: object, target: "folder" | "browser", fileExists: boolean }} state
 * @returns {"save" | "ask" | "overwrite" | "copy"}
 */
export function resolveDuplicateAction({ prefs, record, target, fileExists }) {
  if (!isDownloaded(record)) return "save";
  if (prefs.duplicate === "ask") return "ask";
  return target === "folder" && fileExists ? prefs.duplicate : "save";
}

/**
 * @param {string} filename
 * @param {(name: string) => boolean} isTaken
 * @returns {string} "name (2).md", "name (3).md"… whichever is free first
 */
export function copyFilename(filename, isTaken) {
  const dot = filename.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""];
  for (let number = 2; number < MAX_COPY_NUMBER; number += 1) {
    const candidate = `${stem} (${number})${extension}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${extension}`;
}

/**
 * Fields stored on the record after a successful download.
 * @param {{ at?: Date, target: "folder" | "browser", folderName: string, path: string }} saved
 */
export function buildDownloadMark({ at = new Date(), target, folderName, path }) {
  return { downloadedAt: at.toISOString(), download: { target, folder: target === "folder" ? folderName : "", path } };
}

export function clearedDownloadMark() {
  return { downloadedAt: "", download: null };
}

/** @returns {{ when: string, location: string }} human-readable time and place of the last download */
export function describeDownloadMark(record) {
  const date = new Date(record?.downloadedAt || "");
  const when = Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const saved = record?.download;
  if (!saved?.path) return { when, location: "" };
  const location = saved.target === "folder" ? formatSavedLocation(saved.folder, saved.path) : `${t("浏览器下载")} · ${saved.path.split("/").pop()}`;
  return { when, location };
}

/** @param {string} text start of a saved note @returns {string} its tweet_id property, or "" */
export function frontmatterTweetId(text) {
  const properties = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
  return properties.match(/^tweet_id:\s*"?(\d{1,30})"?\s*$/m)?.[1] || "";
}
