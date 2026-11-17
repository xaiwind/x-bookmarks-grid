import { getStorage, setStorage } from "./chrome-storage.js";
import { ensureLibraryReady, listRecords, mergeLibraryEntries } from "./bookmark-repository.js";
import { syncBookmarkTimeline } from "../src/library-sync.js";
import { parseBookmarkTimeline } from "../src/x-api-parser.js";
import { endedSuspiciouslyEarly, mergeApiRecord, resolveSyncMode, SYNC_ENGINE_VERSION, toApiRecord } from "../src/sync-core.js";
import { t, tr } from "../src/i18n.js";

// X serves the bookmark list at either address depending on the account's rollout.
const BOOKMARK_PAGE_URLS = ["https://x.com/i/bookmarks", "https://x.com/i/history"];
const BRIDGE_FILE = "extension/api-bridge.js";
const CAPTURE_TIMEOUT_MS = 20_000;
const CAPTURE_POLL_MS = 500;
const BRIDGE_INJECT_AFTER_POLLS = 4;
const PAGE_REQUEST_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const WAIT_SLICE_MS = 5000;
const MAX_CAPTURED_LENGTH = 8_000_000;
const LOGIN_PATH = /^\/(i\/flow\/|login|logout|account\/access)/;

let cancelRequested = false;

export function requestSyncCancel() {
  cancelRequested = true;
}

/**
 * Opens X's bookmark page in a background tab, reads the list through the page's own
 * timeline request and stores it. Falls back to the slower scrolling reader when that
 * request cannot be observed.
 *
 * @param {object} params
 * @param {"auto" | "full" | "incremental"} params.requestedMode
 * @param {"manual" | "open" | "alarm"} params.trigger
 * @param {(tab: chrome.tabs.Tab) => Promise<chrome.tabs.Tab>} params.waitForTabLoad
 * @param {() => Promise<{ ok: boolean, message: string }>} params.fallbackFull
 * @param {() => Promise<{ ok: boolean, message: string }>} params.fallbackIncremental
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function runLibrarySync({ requestedMode = "auto", trigger = "manual", waitForTabLoad, fallbackFull, fallbackIncremental }) {
  cancelRequested = false;
  const startedAt = new Date().toISOString();
  let progress = { running: true, mode: "full", trigger, phase: "opening", pages: 0, scanned: 0, added: 0, updated: 0, message: t("正在打开 X 收藏页…"), startedAt, updatedAt: startedAt };
  const publish = async (patch = {}) => {
    progress = { ...progress, ...patch, updatedAt: new Date().toISOString() };
    await setStorage({ syncProgress: progress });
  };
  let heartbeat;
  let tab = null;
  const closeTab = async () => {
    const id = tab?.id;
    tab = null;
    if (id) await chrome.tabs.remove(id).catch(() => {});
  };

  try {
    await ensureLibraryReady();
    const { librarySyncState = {} } = await getStorage(["librarySyncState"]);
    const mode = resolveSyncMode(requestedMode, librarySyncState);
    const storedCount = (await listRecords()).length;
    await publish({ mode });
    await setStorage({ librarySyncState: { ...librarySyncState, lastAttemptAt: startedAt } });
    heartbeat = setInterval(() => { beat(progress, publish).catch(() => {}); }, HEARTBEAT_MS);

    let capture = "timeout";
    for (const url of BOOKMARK_PAGE_URLS) {
      tab = tab ? await chrome.tabs.update(tab.id, { url }) : await chrome.tabs.create({ url, active: false });
      tab = await waitForTabLoad({ ...tab, status: "loading" });
      capture = await waitForTimelineRequest(tab.id);
      if (capture !== "timeout" || cancelRequested) break;
    }
    if (capture === "unreachable") throw new Error(t("打不开 X 页面，请检查网络或代理后重试"));
    if (capture === "logged_out") throw new Error(t("请先在这个 Chrome 里登录 X，然后重新同步"));
    if (cancelRequested) return await finishTimelineSync({ outcome: "cancelled", pages: 0, scanned: 0, added: 0, updated: 0, error: "" }, { mode, trigger, publish });

    let result = null;
    if (capture === "ready") {
      const tabId = tab.id;
      await publish({ phase: "reading", message: t("已连接 X，正在读取收藏…") });
      result = await syncBookmarkTimeline({
        mode,
        fetchPage: (request) => fetchTimelinePage(tabId, request),
        saveRecords: (records) => mergeLibraryEntries(records, mergeApiRecord),
        wait: waitUnlessCancelled,
        isCancelled: () => cancelRequested,
        onProgress: async (update) => {
          await publish({ pages: update.pages, scanned: update.scanned ?? progress.scanned, added: update.added, updated: update.updated, message: progressMessage(update, progress) });
          if (update.phase === "reading") notifyLibraryChanged();
        },
      });
    }

    if (result) await setStorage({ lastSyncTrace: { at: new Date().toISOString(), mode, storedCount, outcome: result.outcome, pages: result.pages, scanned: result.scanned, error: result.error, trace: result.trace } });
    const endedEarly = Boolean(result) && endedSuspiciouslyEarly(result);
    if (!result || result.outcome === "unavailable" || endedEarly) {
      await closeTab();
      const reason = endedEarly ? tr`快速读取在 ${result.scanned.toLocaleString()} 条处无法继续翻页` : t("快速读取暂不可用");
      await publish({ phase: "fallback", message: tr`${reason}，改用页面滚动方式补全（较慢）…` });
      const fallback = mode === "full" ? await fallbackFull() : await fallbackIncremental();
      return await finishFallback(fallback, { mode, trigger, publish });
    }
    return await finishTimelineSync(result, { mode, trigger, publish });
  } catch (error) {
    const message = tr`同步失败：${error instanceof Error ? error.message : t("未知错误")}。已保存的收藏不受影响。`;
    await publish({ running: false, ok: false, phase: "done", message, finishedAt: new Date().toISOString() }).catch(() => {});
    return { ok: false, message };
  } finally {
    clearInterval(heartbeat);
    await closeTab();
    notifyLibraryChanged();
  }
}

/**
 * Stores a timeline response that X's web client loaded while the user browsed their bookmarks.
 * @param {string} text raw response body
 * @returns {Promise<{ ok: boolean, count: number }>}
 */
export async function saveCapturedTimeline(text) {
  if (typeof text !== "string" || text.length > MAX_CAPTURED_LENGTH) return { ok: false, count: 0 };
  let parsed;
  try {
    parsed = parseBookmarkTimeline(JSON.parse(text));
  } catch {
    return { ok: false, count: 0 };
  }
  if (!parsed.tweets.length) return { ok: true, count: 0 };
  const saved = await mergeLibraryEntries(parsed.tweets.map(toApiRecord), mergeApiRecord);
  notifyLibraryChanged();
  return { ok: true, count: saved.added + saved.updated };
}

async function beat(progress, publish) {
  if (progress.phase !== "fallback") return publish();
  const { batchImportState } = await getStorage(["batchImportState"]);
  const detail = batchImportState?.finishedAt > progress.startedAt ? batchImportState.message : "";
  return publish(detail ? { message: tr`兼容模式（较慢）：${detail}` } : {});
}

async function waitForTimelineRequest(tabId) {
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  let injected = false;
  for (let poll = 0; Date.now() < deadline; poll += 1) {
    if (cancelRequested) return "timeout";
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current) throw new Error(t("X 收藏页被关闭"));
    if (isLoginUrl(current.url)) return "logged_out";
    const state = await chrome.tabs.sendMessage(tabId, { type: "GET_BOOKMARK_API_STATE" }).catch(() => null);
    if (state?.ready) return "ready";
    if (!state && !injected && poll >= BRIDGE_INJECT_AFTER_POLLS) {
      injected = true;
      const failure = await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE_FILE] }).then(() => "", (error) => String(error?.message || error));
      if (/error page|cannot access|cannot be scripted/i.test(failure)) return "unreachable";
    }
    await sleep(CAPTURE_POLL_MS);
  }
  return "timeout";
}

function isLoginUrl(value) {
  try {
    return LOGIN_PATH.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function fetchTimelinePage(tabId, { cursor, count }) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, status: 0, error: t("读取 X 收藏超时。") }), PAGE_REQUEST_TIMEOUT_MS);
  });
  const request = chrome.tabs.sendMessage(tabId, { type: "FETCH_BOOKMARK_API_PAGE", cursor, count })
    .catch(() => ({ ok: false, status: 0, error: t("X 收藏页已关闭或失去响应。") }));
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

async function waitUnlessCancelled(ms) {
  for (let remaining = ms; remaining > 0 && !cancelRequested; remaining -= WAIT_SLICE_MS) {
    await sleep(Math.min(remaining, WAIT_SLICE_MS));
  }
}

function progressMessage(update, progress) {
  const scanned = update.scanned ?? progress.scanned;
  if (update.phase === "rate_limited") {
    return tr`X 暂时限制了读取频率，约 ${Math.round((update.waitMs || 0) / 1000)} 秒后自动继续。已读取 ${scanned.toLocaleString()} 条。`;
  }
  return tr`正在读取收藏：已读取 ${scanned.toLocaleString()} 条，新增 ${update.added.toLocaleString()} 条。`;
}

async function finishTimelineSync(result, { mode, trigger, publish }) {
  const finishedAt = new Date().toISOString();
  const reachedEnd = result.outcome === "completed";
  const ok = reachedEnd || result.outcome === "caught_up";
  const scanned = result.scanned.toLocaleString();
  const added = result.added.toLocaleString();
  const message = {
    completed: tr`同步完成：X 收藏夹里现有的 ${scanned} 条已全部读取，新增 ${added} 条。`,
    caught_up: result.added ? tr`同步完成：新增 ${added} 条收藏。` : t("已是最新，没有新的收藏。"),
    cancelled: tr`已停止同步，本次读取的 ${scanned} 条已保存。`,
    page_limit: tr`本次读取达到上限，已保存 ${scanned} 条。再次点击同步可继续。`,
    failed: tr`同步中断：${result.error} 本次读取的 ${scanned} 条已保存，再次点击同步即可继续。`,
  }[result.outcome] || tr`同步结束，已保存 ${scanned} 条。`;

  const { librarySyncState = {}, batchImportState = {} } = await getStorage(["librarySyncState", "batchImportState"]);
  await setStorage({
    librarySyncState: {
      ...librarySyncState,
      ...(ok ? { lastSyncAt: finishedAt } : {}),
      ...(reachedEnd ? { fullSyncCompletedAt: finishedAt, engineVersion: SYNC_ENGINE_VERSION } : {}),
      lastMode: mode,
    },
    ...(reachedEnd ? {
      batchImportState: { ...batchImportState, finished: true, historyImportVersion: 1, xTotal: result.scanned, xTotalAt: finishedAt, scannedCount: result.scanned, message, finishedAt },
    } : {}),
    lastSync: { type: mode === "full" ? t("完整同步") : t("同步新收藏"), finishedAt, message },
    ...(trigger === "alarm" ? { lastAutoSync: { finishedAt, added: result.added, failed: 0, message } } : {}),
  });
  await publish({ running: false, ok, phase: "done", message, finishedAt });
  return { ok, message };
}

async function finishFallback(fallback, { mode, trigger, publish }) {
  const finishedAt = new Date().toISOString();
  const ok = Boolean(fallback?.ok);
  const message = fallback?.message || (ok ? t("同步完成。") : t("同步未完成。"));
  if (ok) {
    const { librarySyncState = {} } = await getStorage(["librarySyncState"]);
    await setStorage({
      librarySyncState: { ...librarySyncState, lastSyncAt: finishedAt, lastMode: mode, ...(mode === "full" ? { fullSyncCompletedAt: finishedAt, engineVersion: SYNC_ENGINE_VERSION } : {}) },
      ...(trigger === "alarm" && mode === "full" ? { lastAutoSync: { finishedAt, added: 0, failed: 0, message } } : {}),
    });
  }
  await publish({ running: false, ok, phase: "done", message, finishedAt });
  return { ok, message };
}

function notifyLibraryChanged() {
  chrome.runtime.sendMessage({ type: "BOOKMARK_LIBRARY_REPLACED" }).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
