import { parseBookmarkTimeline } from "./x-api-parser.js";
import { toApiRecord } from "./sync-core.js";
import { t, tr } from "./i18n.js";

export const SYNC_OPTIONS = Object.freeze({
  // 0 keeps the page size X's own client uses, so each request differs from X's only by its cursor.
  pageSize: 0,
  pageDelayMs: 600,
  traceLimit: 60,
  maxPages: 3000,
  rateLimitRetries: 4,
  rateLimitWaitMs: 60_000,
  transientRetries: 2,
  transientWaitMs: 3000,
});

/**
 * Reads the bookmark timeline page by page and stores every page as soon as it arrives,
 * so an interruption never loses what was already read.
 *
 * @param {object} deps
 * @param {"full" | "incremental"} deps.mode full reads to the end; incremental stops at the first page without new items
 * @param {(request: { cursor: string, count: number }) => Promise<{ ok: boolean, status?: number, text?: string, error?: string }>} deps.fetchPage
 * @param {(records: object[]) => Promise<{ added: number, updated: number, refreshed?: number }>} deps.saveRecords
 * @param {(ms: number, reason: string) => Promise<void>} deps.wait
 * @param {(progress: object) => (void | Promise<void>)} [deps.onProgress]
 * @param {() => boolean} [deps.isCancelled]
 * @param {Partial<typeof SYNC_OPTIONS>} [deps.options]
 * @returns {Promise<{ outcome: "completed" | "stalled" | "caught_up" | "cancelled" | "unavailable" | "failed" | "page_limit", trace: object[], pages: number, scanned: number, added: number, updated: number, error: string }>}
 */
export async function syncBookmarkTimeline({ mode, fetchPage, saveRecords, wait, onProgress = () => {}, isCancelled = () => false, options = {} }) {
  const settings = { ...SYNC_OPTIONS, ...options };
  const seenIds = new Set();
  const totals = { pages: 0, scanned: 0, added: 0, updated: 0 };
  const trace = [];
  const finish = (outcome, error = "") => ({ outcome, ...totals, scanned: seenIds.size, error, trace });
  let cursor = "";
  let count = settings.pageSize;

  while (totals.pages < settings.maxPages) {
    if (isCancelled()) return finish("cancelled");
    let page = await requestPage({ fetchPage, wait, cursor, count, settings, onProgress, totals: { ...totals, scanned: seenIds.size } });
    if (!page.ok && totals.pages === 0 && count !== 0 && !page.rateLimited) {
      // The first request asks for a larger page than X's own client; fall back to its default size.
      count = 0;
      page = await requestPage({ fetchPage, wait, cursor, count, settings, onProgress, totals: { ...totals, scanned: seenIds.size } });
    }
    if (!page.ok) return finish(totals.pages === 0 ? "unavailable" : "failed", page.error);

    const fresh = page.tweets.filter((tweet) => !seenIds.has(tweet.id));
    for (const tweet of fresh) seenIds.add(tweet.id);
    const saved = fresh.length ? await saveRecords(fresh.map(toApiRecord)) : { added: 0, updated: 0 };
    totals.pages += 1;
    totals.added += saved.added;
    totals.updated += saved.updated;
    await onProgress({ ...totals, scanned: seenIds.size, phase: "reading" });

    if (trace.length < settings.traceLimit) trace.push({ tweets: page.tweets.length, fresh: fresh.length, hasCursor: Boolean(page.nextCursor), sameCursor: page.nextCursor === cursor });

    // The real end of the list is a page without posts or without a way to continue.
    if (!page.tweets.length || !page.nextCursor) return finish("completed");
    // A page that only repeats known posts means paging is not advancing; that is not the end.
    if (!fresh.length || page.nextCursor === cursor) return finish("stalled");
    // Keep going while pages still bring new posts or re-bookmarked ones that were already stored.
    if (mode === "incremental" && saved.added === 0 && !(saved.refreshed > 0)) return finish("caught_up");
    cursor = page.nextCursor;
    await wait(settings.pageDelayMs, "pace");
  }
  return finish("page_limit");
}

async function requestPage({ fetchPage, wait, cursor, count, settings, onProgress, totals }) {
  let rateLimitAttempts = 0;
  let transientAttempts = 0;
  for (;;) {
    const response = await safeFetch(fetchPage, { cursor, count });
    if (response.ok) {
      const parsed = parsePage(response.text);
      if (parsed) return { ok: true, ...parsed };
      return { ok: false, error: t("X 返回了无法识别的收藏数据。") };
    }
    if (response.status === 429) {
      if (rateLimitAttempts >= settings.rateLimitRetries) return { ok: false, rateLimited: true, error: t("X 暂时限制了读取频率，请稍后再继续。") };
      rateLimitAttempts += 1;
      await onProgress({ ...totals, phase: "rate_limited", waitMs: settings.rateLimitWaitMs });
      await wait(settings.rateLimitWaitMs, "rate_limit");
      continue;
    }
    const transient = !response.status || response.status >= 500;
    if (transient && transientAttempts < settings.transientRetries) {
      transientAttempts += 1;
      await wait(settings.transientWaitMs, "retry");
      continue;
    }
    // Messages produced inside the X page arrive in Chinese; translate them where they surface.
    return { ok: false, error: response.status ? tr`X 返回了错误（${response.status}）。` : t(response.error || "X 页面没有响应。") };
  }
}

async function safeFetch(fetchPage, request) {
  try {
    const response = await fetchPage(request);
    return response && typeof response === "object" ? response : { ok: false, error: t("X 页面没有响应。") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : t("X 页面没有响应。") };
  }
}

function parsePage(text) {
  try {
    const parsed = parseBookmarkTimeline(JSON.parse(String(text || "")));
    return parsed.hasTimeline ? parsed : null;
  } catch {
    return null;
  }
}
