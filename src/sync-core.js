import { normalizeTweet } from "./core.js";
import { t, tr } from "./i18n.js";

export const AUTO_OPEN_SYNC_INTERVAL_MS = 30 * 60 * 1000;
export const PROGRESS_STALE_MS = 90 * 1000;
// Raised when an earlier version could wrongly record a partial read as complete.
export const SYNC_ENGINE_VERSION = 2;
const FAILED_ATTEMPT_RETRY_MS = 10 * 60 * 1000;

const PLACEHOLDER_TITLE = /^(X书签-\d+|X ?书签)$/;
const EXTRA_FIELDS = ["authorName", "coverRatio", "bookmarkSortIndex", "dataSource", "untitled"];

/**
 * Converts a parsed timeline tweet into a library record. Post bodies are never stored.
 * @param {object} tweet output of parseTweetResult
 * @returns {object}
 */
export function toApiRecord(tweet) {
  const base = normalizeTweet({ ...tweet, text: "", contentStatus: "url_only", syncStatus: "indexed" });
  const extras = Object.fromEntries(EXTRA_FIELDS.filter((field) => tweet[field]).map((field) => [field, tweet[field]]));
  return { ...base, ...extras };
}

/**
 * Merges fresh timeline data into a stored record without losing anything the user or
 * an earlier detail check added.
 * @param {object | null | undefined} existing
 * @param {object} incoming record from toApiRecord
 * @returns {object}
 */
export function mergeApiRecord(existing, incoming) {
  if (!existing) return incoming;
  const keepVerifiedArticle = Boolean(existing.classificationVerified && existing.classificationVersion >= 4 && incoming.isArticle && !incoming.classificationVerified);
  const verified = keepVerifiedArticle
    ? { classificationVerified: true, classificationVersion: existing.classificationVersion, postType: existing.postType, textLength: existing.textLength }
    : {};
  return {
    ...existing,
    ...incoming,
    ...verified,
    title: existing.titleEdited || PLACEHOLDER_TITLE.test(incoming.title || "") ? existing.title || incoming.title : incoming.title,
    untitled: PLACEHOLDER_TITLE.test(incoming.title || "") && Boolean(incoming.untitled || existing.untitled) && !existing.titleEdited,
    // A post deleted from the library comes back only when it is bookmarked again on X.
    hidden: Boolean(existing.hidden) && !wasBookmarkedAgain(existing, incoming),
    author: incoming.author && incoming.author !== "unknown" ? incoming.author : existing.author || incoming.author,
    url: incoming.author && incoming.author !== "unknown" ? incoming.url : existing.url || incoming.url,
    views: incoming.views || existing.views || "",
    createdAt: incoming.createdAt || existing.createdAt || "",
    articleUrl: incoming.articleUrl || existing.articleUrl || "",
    imageUrls: union(incoming.imageUrls, existing.imageUrls),
    externalUrls: union(existing.externalUrls, incoming.externalUrls),
    hasVideo: Boolean(incoming.hasVideo || existing.hasVideo),
    category: existing.category || incoming.category,
    syncedAt: existing.syncedAt || incoming.syncedAt,
    text: "",
    file: existing.file || "",
    contentStatus: existing.contentStatus || incoming.contentStatus,
    articleStatus: existing.articleStatus || incoming.articleStatus,
    syncStatus: existing.syncStatus || incoming.syncStatus,
    downloadedAt: existing.downloadedAt || "",
    projectIds: union(existing.projectIds, []),
    note: existing.note || "",
    reason: existing.reason || "",
    useCase: existing.useCase || "",
  };
}

/**
 * True when a stored record just gained timeline data or moved in the list, which is what
 * happens when a post is bookmarked again after having been removed.
 */
export function isRepositionedRecord(existing, incoming) {
  if (!existing) return false;
  return existing.dataSource !== "api" || String(existing.bookmarkSortIndex || "") !== String(incoming.bookmarkSortIndex || "");
}

function wasBookmarkedAgain(existing, incoming) {
  return Boolean(existing.bookmarkSortIndex && incoming.bookmarkSortIndex && existing.bookmarkSortIndex !== incoming.bookmarkSortIndex);
}

/** Orders by X's timeline position. Larger means bookmarked more recently; missing values sort last. */
export function compareSortIndex(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || !b) return Number(Boolean(b)) - Number(Boolean(a));
  if (a.length !== b.length) return b.length - a.length;
  return a === b ? 0 : a < b ? 1 : -1;
}

/**
 * A library that has never been read to the end needs a full pass; afterwards only new items are read.
 * @param {string} requested "auto" | "full" | "incremental"
 * @param {{ fullSyncCompletedAt?: string }} syncState
 * @returns {"full" | "incremental"}
 */
export function resolveSyncMode(requested, syncState = {}) {
  if (requested === "full") return "full";
  return hasCompletedFullSync(syncState) ? "incremental" : "full";
}

/** Whether the whole list has been read to the end by a version whose result can be trusted. */
export function hasCompletedFullSync(syncState = {}) {
  return Boolean(syncState?.fullSyncCompletedAt) && Number(syncState?.engineVersion) >= SYNC_ENGINE_VERSION;
}

/**
 * Paging that stopped advancing did not reach the end of the list. A list that really ended can
 * be much shorter than the library, because posts removed from X's bookmarks stay stored locally.
 * @param {{ outcome: string }} result
 */
export function endedSuspiciouslyEarly(result) {
  return result?.outcome === "stalled";
}

/** Decides whether opening the popup or the library page should start a sync by itself. */
export function shouldAutoSyncOnOpen({ settings = {}, syncState = {}, running = false, now = Date.now() } = {}) {
  if (running || settings?.autoSyncEnabled === false) return false;
  if (!hasCompletedFullSync(syncState)) {
    const lastAttempt = Date.parse(syncState?.lastAttemptAt || "");
    return !Number.isFinite(lastAttempt) || now - lastAttempt > FAILED_ATTEMPT_RETRY_MS;
  }
  const last = Date.parse(syncState?.lastSyncAt || "");
  return !Number.isFinite(last) || now - last > AUTO_OPEN_SYNC_INTERVAL_MS;
}

/** A running flag left behind by a stopped service worker must not block the UI forever. */
export function isProgressStale(progress, now = Date.now()) {
  if (!progress?.running) return false;
  const updated = Date.parse(progress.updatedAt || "");
  return !Number.isFinite(updated) || now - updated > PROGRESS_STALE_MS;
}

/**
 * @returns {{ active: boolean, text: string, percent: number | null }}
 */
export function describeSyncProgress(progress, { now = Date.now(), knownTotal = null } = {}) {
  if (!progress) return { active: false, text: "", percent: null };
  if (progress.running && isProgressStale(progress, now)) {
    return { active: false, text: t("上次同步被中断，已读取的收藏都已保存。点击同步可继续。"), percent: null };
  }
  if (!progress.running) return { active: false, text: progress.message || "", percent: null };
  const scanned = Number(progress.scanned) || 0;
  const percent = progress.mode === "full" && Number.isSafeInteger(knownTotal) && knownTotal > 0
    ? Math.min(99, Math.floor((scanned / knownTotal) * 100))
    : null;
  return { active: true, text: progress.message || t("正在同步收藏…"), percent };
}

function union(first = [], second = []) {
  return [...new Set([...(first || []), ...(second || [])])];
}
