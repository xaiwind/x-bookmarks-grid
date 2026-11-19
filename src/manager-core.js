import { needsTitleBackfill } from "./core.js";
import { compareSortIndex } from "./sync-core.js";
import { getLanguage, t, tr } from "./i18n.js";

export function recordDisplayTitle(record = {}) {
  const directTitle = cleanTitle(record.title);
  if (directTitle) return directTitle;

  const textTitle = cleanTitle(record.text);
  if (textTitle) return textTitle;

  if (record.id) return `X书签-${record.id}`;
  return t("无标题");
}

export function collectCategoryOptions(records = []) {
  const categories = records
    .map((record) => record.category)
    .filter(Boolean)
    .map((category) => String(category).trim())
    .filter(Boolean);
  return [...new Set(categories)];
}

export function parseViewCount(value) {
  const match = String(value || "").trim().replace(/,/g, "").toUpperCase().match(/([\d.]+)\s*(K|M|B|万|亿)?/);
  if (!match) return 0;
  return Number(match[1]) * ({ K: 1_000, M: 1_000_000, B: 1_000_000_000, "万": 10_000, "亿": 100_000_000 }[match[2]] || 1);
}

export function summarizeBookmarkCounts(records = [], state = {}) {
  const exact = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { sourceTotal: exact(state?.xTotal), syncedTotal: records.length, scannedCount: exact(state?.scannedCount) };
}

export function bookmarkSourceDisplay(counts) {
  if (counts.sourceTotal !== null) return { label: t("X 收藏总数"), value: counts.sourceTotal.toLocaleString() };
  if (counts.scannedCount > 0) return { label: t("X 收藏（已扫描）"), value: `≥${counts.scannedCount.toLocaleString()}` };
  return { label: t("X 收藏总数"), value: t("未获取") };
}

export function describeBookmarkCounts(counts) {
  const scanned = counts.scannedCount !== null ? tr`本次已读取 ${counts.scannedCount.toLocaleString()} 条。` : "";
  if (counts.sourceTotal === null) return tr`暂未获取 X 收藏总数，已扫描数是下限，无法确认是否全部同步。${scanned}`;
  if (counts.sourceTotal > counts.syncedTotal) return tr`X 上次显示的数量高于本地，可能仍有收藏未读取，可继续同步。${scanned}`;
  return tr`X 上次显示的数量与本地仅供参考，本地可能保留已取消的收藏。${scanned}`;
}

export function getBookmarkPostType(record = {}) {
  if (!(record.classificationVersion >= 4)) return "unknown";
  if (record.classificationVerified && Number.isFinite(record.textLength) && record.textLength > 3000) return "long";
  if (record.isArticle) return "unknown";
  if (Number.isFinite(record.textLength) && record.textLength > 3000) return "long";
  if (record.postType === "short") return "short";
  return "unknown";
}

export function isRecognizedArticle(record = {}) {
  return record.classificationVersion >= 4 && Boolean(record.isArticle);
}

export function sortBookmarkRecords(records, order = "newest") {
  return [...records].sort((a, b) => {
    if (order === "views") return parseViewCount(b.views) - parseViewCount(a.views);
    if (order === "bookmarked") {
      const byPosition = compareSortIndex(a.bookmarkSortIndex, b.bookmarkSortIndex);
      if (byPosition) return byPosition;
    }
    const field = order === "imported" ? "syncedAt" : "createdAt";
    const left = Date.parse(a[field] || "");
    const right = Date.parse(b[field] || "");
    if (!Number.isFinite(left) || !Number.isFinite(right)) return Number(Number.isFinite(right)) - Number(Number.isFinite(left));
    return order === "oldest" ? left - right : right - left;
  });
}

// Every record belongs to exactly one category, so the category counts add up to the total.
export const BOOKMARK_CATEGORIES = Object.freeze(["article", "video", "image", "text", "untitled"]);
export const BOOKMARK_TYPE_FILTERS = Object.freeze(["all", ...BOOKMARK_CATEGORIES]);

function recordHasVideo(record) {
  return Boolean(record.hasVideo || record.videoUrl || (record.videoUrls || []).length);
}

/**
 * The single category a record is filed under. Earlier checks win: a post without a real title
 * is "untitled" whatever it contains, then articles, then posts with video, then with images.
 * @returns {"untitled" | "article" | "video" | "image" | "text"}
 */
export function bookmarkCategory(record = {}) {
  if (record.untitled || needsTitleBackfill(record)) return "untitled";
  if (isRecognizedArticle(record)) return "article";
  if (recordHasVideo(record)) return "video";
  if ((record.imageUrls || []).length > 0) return "image";
  return "text";
}

/** @returns {boolean} whether a record is shown under one of BOOKMARK_TYPE_FILTERS */
export function matchesBookmarkType(record = {}, type = "all") {
  return type === "all" || !type || bookmarkCategory(record) === type;
}

/** @returns {Record<string, number>} records per filter; the categories always sum to `all` */
export function countBookmarkTypes(records = []) {
  const counts = Object.fromEntries(BOOKMARK_TYPE_FILTERS.map((type) => [type, 0]));
  for (const record of records) counts[bookmarkCategory(record)] += 1;
  return { ...counts, all: records.length };
}

/**
 * @param {object[]} records
 * @param {{ query?: string, author?: string, fromDate?: string, toDate?: string, hasLinks?: string, type?: string, minViews?: number | string }} filters
 * @returns {object[]}
 */
export function filterBookmarkRecords(records = [], filters = {}) {
  const terms = String(filters.query || "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const author = String(filters.author || "").trim().replace(/^@/, "").toLocaleLowerCase();
  const { fromDate = "", toDate = "", hasLinks = "", downloaded = "", type = "all" } = filters;
  const minViews = Number(filters.minViews) || 0;
  return records.filter((record) => {
    if (!matchesBookmarkType(record, type)) return false;
    if (minViews > 0 && parseViewCount(record.views) < minViews) return false;
    const handle = String(record.author || "").toLocaleLowerCase();
    const name = String(record.authorName || "").toLocaleLowerCase();
    if (author && !handle.includes(author) && !name.includes(author)) return false;
    const linkCount = (record.externalUrls || []).length;
    if (hasLinks === "yes" && !linkCount) return false;
    if (hasLinks === "no" && linkCount) return false;
    if (downloaded === "yes" && !record.downloadedAt) return false;
    if (downloaded === "no" && record.downloadedAt) return false;
    if (fromDate || toDate) {
      const dateKey = localDateKey(record.createdAt || record.syncedAt);
      if (!dateKey || (fromDate && dateKey < fromDate) || (toDate && dateKey > toDate)) return false;
    }
    if (!terms.length) return true;
    const haystack = [record.title, record.note, record.author, record.authorName, record.url, ...(record.externalUrls || [])].join(" ").toLocaleLowerCase();
    return terms.every((term) => (term.length > 1 && term.startsWith("@") ? handle.includes(term.slice(1)) : haystack.includes(term)));
  });
}

/** @returns {{ author: string, count: number }[]} authors with the most bookmarks first */
export function listTopAuthors(records = [], limit = 200) {
  const counts = new Map();
  const names = new Map();
  for (const record of records) {
    const author = String(record.author || "").trim();
    if (!author || author === "unknown") continue;
    counts.set(author, (counts.get(author) || 0) + 1);
    // Nicknames change over time: keep the one from the author's newest post that has one.
    const name = String(record.authorName || "").trim();
    const date = String(record.createdAt || "");
    if (name && (!names.has(author) || date >= names.get(author).date)) names.set(author, { name, date });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([author, count]) => ({ author, name: names.get(author)?.name || "", count }));
}

/**
 * Narrows the author list to what the user typed (handle or nickname); empty text keeps every author.
 * @param {{ author: string, name?: string, count: number }[]} authors
 * @param {string} text
 * @param {number} limit
 */
export function filterAuthorOptions(authors = [], text = "", limit = 150) {
  const needle = String(text || "").trim().replace(/^@/, "").toLocaleLowerCase();
  const matches = needle ? authors.filter(({ author, name = "" }) => author.toLocaleLowerCase().includes(needle) || name.toLocaleLowerCase().includes(needle)) : authors;
  return matches.slice(0, limit);
}

/** Formats a view count compactly: 9876, 1.2万, 3.4亿 in Chinese; 9,876, 12.3K, 1.2M in English. */
export function formatCompactCount(value) {
  const count = parseViewCount(value);
  if (!Number.isFinite(count) || count <= 0) return "";
  const trim = (number) => String(Math.round(number * 10) / 10);
  if (getLanguage() === "en") {
    if (count >= 1_000_000_000) return `${trim(count / 1_000_000_000)}B`;
    if (count >= 1_000_000) return `${trim(count / 1_000_000)}M`;
    if (count >= 1_000) return `${trim(count / 1_000)}K`;
    return String(Math.round(count));
  }
  if (count >= 100_000_000) return `${trim(count / 100_000_000)}亿`;
  if (count >= 10_000) return `${trim(count / 10_000)}万`;
  return String(Math.round(count));
}

/** How many masonry columns fit a container. */
export function columnCountForWidth(width, { minColumnWidth = 250, gap = 18, maxColumns = 6 } = {}) {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.min(maxColumns, Math.floor((width + gap) / (minColumnWidth + gap))));
}

function localDateKey(value) {
  const date = new Date(value || "");
  if (!value || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function cleanTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || /^https?:\/\//i.test(text)) return "";
  return text.slice(0, 90);
}
