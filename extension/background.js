import { buildSeenRecord, mergeIndexedRecord, needsTitleBackfill, normalizeTweet } from "../src/core.js";
import { mergeImportedRecord } from "../src/library-core.js";
import { getStorage, setStorage } from "./chrome-storage.js";
import { ensureLibraryReady, listRecords, putLibraryEntry, replaceLibraryData } from "./bookmark-repository.js";
import { getNextScheduledTime } from "../src/auto-sync-core.js";
import { prepareImportBatch } from "../src/batch-import-core.js";
import { isBookmarkPageUrl } from "../src/bookmark-route.js";
import { getBookmarkPostType } from "../src/manager-core.js";
import { readPostLengthFromPage } from "./detail-reader.js";
import { readPostTitleFromPage } from "./title-reader.js";
import { importBundledBackupOnce } from "./bundled-backup.js";
import { readPostMarkdownFromPage } from "./article-reader.js";
import { readCapturedMedia, withPostHook } from "./post-media-reader.js";
import { requestSyncCancel, runLibrarySync, saveCapturedTimeline } from "./library-sync-runner.js";
import { shouldAutoSyncOnOpen, SYNC_ENGINE_VERSION } from "../src/sync-core.js";
import { initLanguage, t, tr } from "../src/i18n.js";

initLanguage();

const AUTO_SYNC_ALARM = "x-bookmark-daily-sync";
const BATCH_SIZE = 50;
const BOOKMARK_TAB_URLS = ["https://x.com/i/bookmarks*", "https://twitter.com/i/bookmarks*", "https://x.com/i/history*", "https://twitter.com/i/history*"];
let importRunning = false;
const DEFAULT_SETTINGS = {
  autoSyncEnabled: true,
  autoSyncTime: "01:00",
  autoSyncTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei",
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["settings"], ({ settings = {} }) => {
    chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings } }, () => ensureAutoSyncAlarm());
  });
});
chrome.runtime.onStartup.addListener(() => ensureAutoSyncAlarm(true));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) ensureAutoSyncAlarm().then(() => startLibrarySync("auto", "alarm"));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) ensureAutoSyncAlarm();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_LIBRARY_SYNC") {
    sendResponse(startLibrarySync(message.mode === "full" ? "full" : "auto", "manual"));
    return false;
  }
  if (message?.type === "LIBRARY_OPENED") {
    handleLibraryOpened().then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "STOP_LIBRARY_SYNC") {
    requestSyncCancel();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "SAVE_CAPTURED_BOOKMARK_PAGE") {
    saveCapturedPage(sender, message.text).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "SYNC_VISIBLE_BOOKMARKS") {
    runExclusiveImport(() => syncVisibleBookmarks(sender, message.tweets, message.bookmarkTotal)).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "SYNC_SINGLE_RECORD") {
    runExclusiveImport(() => syncSingleRecord(message.id)).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "READ_POST_MARKDOWN") {
    runExclusiveImport(() => readPostMarkdown(message.id)).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "FILL_MISSING_TITLES_BATCH") {
    runExclusiveImport(fillMissingTitlesBatch).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "CLASSIFY_POSTS_BATCH") {
    runExclusiveImport(classifyPostsBatch).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "RUN_AUTO_SYNC_NOW") {
    runExclusiveImport(() => runAutomaticSync(true)).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "SYNC_BOOKMARK_INDEX_NOW") {
    runExclusiveImport(syncBookmarkIndex).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "RESET_AND_REIMPORT_BOOKMARKS") {
    runExclusiveImport(() => importAllBookmarks(true)).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "IMPORT_ALL_BOOKMARKS") {
    runExclusiveImport(() => importAllBookmarks(false)).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "IMPORT_BOOKMARK_BATCH") {
    runExclusiveImport(() => importBookmarkBatch(false)).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === "UPDATE_AUTO_SYNC") {
    chrome.storage.local.get(["settings"], ({ settings = {} }) => {
      chrome.storage.local.set({ settings: { ...settings, ...message.settings } }, () => {
        ensureAutoSyncAlarm().then(() => sendResponse({ ok: true }));
      });
    });
    return true;
  }
  return false;
});

// Starts a sync without holding the caller's message open; progress is published to storage.
function startLibrarySync(requestedMode, trigger) {
  if (importRunning) return { ok: true, started: false, alreadyRunning: true };
  runExclusiveImport(() => runLibrarySync({
    requestedMode,
    trigger,
    waitForTabLoad,
    fallbackFull: () => importAllBookmarks(false),
    fallbackIncremental: () => runAutomaticSync(true),
  })).catch(() => {});
  return { ok: true, started: true };
}

async function handleLibraryOpened() {
  const restored = await importBundledBackupOnce().catch(() => ({ imported: 0 }));
  if (restored.imported) chrome.runtime.sendMessage({ type: "BOOKMARK_LIBRARY_REPLACED" }).catch(() => {});
  const { settings = {}, librarySyncState = {}, syncProgress } = await getStorage(["settings", "librarySyncState", "syncProgress"]);
  if (!importRunning && syncProgress?.running) {
    // The service worker was stopped mid-sync; everything read so far is already stored.
    await setStorage({ syncProgress: { ...syncProgress, running: false, ok: false, message: t("上次同步被中断，已读取的收藏都已保存。"), finishedAt: new Date().toISOString() } });
  }
  // The engine number lets an open page notice that this background script is older than the page.
  if (!shouldAutoSyncOnOpen({ settings, syncState: librarySyncState, running: importRunning })) return { ok: true, started: false, alreadyRunning: importRunning, engine: SYNC_ENGINE_VERSION };
  return { ...startLibrarySync("auto", "open"), engine: SYNC_ENGINE_VERSION };
}

async function saveCapturedPage(sender, text) {
  if (!isBookmarkPageUrl(sender.tab?.url)) return { ok: false, message: t("当前页面不是书签列表。") };
  const { settings = {} } = await getStorage(["settings"]);
  if (settings.autoSyncEnabled === false) return { ok: true, skipped: true };
  return saveCapturedTimeline(text);
}

const TITLE_BATCH_SIZE = 8;
const TITLE_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

function canReadTitle(record) {
  return needsTitleBackfill(record) && /^\d+$/.test(String(record.id || "")) && isSafeDetailUrl(record.url)
    && (!record.titleAttemptedAt || Date.now() - Date.parse(record.titleAttemptedAt) > TITLE_RETRY_AFTER_MS);
}

// Posts that are no longer in X's bookmarks cannot be refreshed by a sync, so their titles are
// read one by one from the post page in a single reused background tab.
async function fillMissingTitlesBatch() {
  const candidates = (await listRecords()).filter(canReadTitle);
  if (!candidates.length) return { ok: true, filled: 0, untitled: 0, failed: 0, remaining: 0 };
  const batch = candidates.slice(0, TITLE_BATCH_SIZE);
  const tabRef = { tab: null };
  const counts = { filled: 0, untitled: 0, failed: 0 };
  try {
    for (const record of batch) {
      const outcome = await refreshRecordFromPost(record, tabRef);
      counts[outcome.ok ? (outcome.untitled ? "untitled" : "filled") : "failed"] += 1;
    }
    chrome.runtime.sendMessage({ type: "BOOKMARK_LIBRARY_REPLACED" }).catch(() => {});
    return { ok: true, ...counts, remaining: candidates.length - batch.length };
  } finally {
    if (tabRef.tab?.id) await chrome.tabs.remove(tabRef.tab.id).catch(() => {});
  }
}

async function openPostInTab(record, tabRef) {
  const opened = tabRef.tab
    ? await chrome.tabs.update(tabRef.tab.id, { url: record.url, active: false })
    : await chrome.tabs.create({ url: record.url, active: false });
  tabRef.tab = opened;
  tabRef.tab = await waitForTabLoad({ ...opened, status: "loading" });
  return tabRef.tab;
}

// Visits one post and stores its title and covers. A title the user edited is never replaced.
async function refreshRecordFromPost(record, tabRef) {
  const attemptedAt = new Date().toISOString();
  try {
    const tab = await openPostInTab(record, tabRef);
    const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPostTitleFromPage, args: [String(record.id)] });
    const detail = result?.[0]?.result;
    if (!detail?.ok) throw new Error(t(detail?.error || "未读取到帖子"));
    const title = record.titleEdited || !detail.title ? record.title : detail.title;
    const next = { ...record, title, untitled: Boolean(detail.untitled), text: "", titleAttemptedAt: attemptedAt, imageUrls: [...new Set([...(detail.imageUrls || []), ...(record.imageUrls || [])])] };
    await putLibraryEntry(next, buildSeenRecord(next, next.file || ""));
    return { ok: true, untitled: Boolean(detail.untitled), title };
  } catch (error) {
    await putLibraryEntry({ ...record, text: "", titleAttemptedAt: attemptedAt }, buildSeenRecord(record, record.file || ""));
    return { ok: false, message: t(error.message) };
  }
}

async function findReadableRecord(id) {
  const record = (await listRecords()).find((item) => item.id === String(id || ""));
  if (!record) throw new Error(t("本地没有这条收藏"));
  if (!/^\d+$/.test(String(record.id)) || !isSafeDetailUrl(record.url)) throw new Error(t("这条收藏没有可访问的原帖链接"));
  return record;
}

async function syncSingleRecord(id) {
  const record = await findReadableRecord(id);
  const tabRef = { tab: null };
  try {
    const outcome = await refreshRecordFromPost(record, tabRef);
    chrome.runtime.sendMessage({ type: "BOOKMARK_LIBRARY_REPLACED" }).catch(() => {});
    if (!outcome.ok) return { ok: false, message: tr`同步失败：${outcome.message}` };
    return { ok: true, message: outcome.untitled ? t("已同步：这是一条只有图片或视频、没有文字的帖子，所以没有标题。") : tr`已同步：${outcome.title}` };
  } finally {
    if (tabRef.tab?.id) await chrome.tabs.remove(tabRef.tab.id).catch(() => {});
  }
}

// Reads one post's content for a download the user asked for. The content is returned to the
// page that requested it and is not written to the library.
async function readPostMarkdown(id) {
  const record = await findReadableRecord(id);
  const tabRef = { tab: null };
  try {
    const { result } = await withPostHook(async () => {
      const tab = await openPostInTab(record, tabRef);
      const injection = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPostMarkdownFromPage, args: [String(record.id), (record.imageUrls || []).length] });
      const { media, layout, views } = await readCapturedMedia(tab.id, String(record.id));
      return { detail: injection?.[0]?.result, media, layout, views };
    });
    const { detail, media, layout, views } = result;
    if (!detail?.ok) return { ok: false, message: t(detail?.error || "没有读到正文"), media, layout, views };
    return { ok: true, title: String(detail.title || ""), markdown: String(detail.markdown || ""), isArticle: Boolean(detail.isArticle), media, layout, views };
  } finally {
    if (tabRef.tab?.id) await chrome.tabs.remove(tabRef.tab.id).catch(() => {});
  }
}

async function classifyPostsBatch() {
  const candidates = (await listRecords()).filter((record) =>
    getBookmarkPostType(record) === "unknown" && (!record.classificationVerified || record.classificationVersion < 4) &&
    /^\d+$/.test(String(record.id || "")) &&
    isSafeDetailUrl(record.url) &&
    (!record.classificationAttemptedAt || Date.now() - Date.parse(record.classificationAttemptedAt) > 300_000)
  ).sort((a, b) => Number(Boolean(b.isArticle && b.classificationVersion >= 4)) - Number(Boolean(a.isArticle && a.classificationVersion >= 4)));
  if (!candidates.length) return { ok: true, checked: 0, failed: 0, remaining: 0, message: t("当前可识别的收藏已处理；无法加载的内容稍后可重试。") };
  const batch = candidates.slice(0, 10);
  let tab;
  let checked = 0;
  let failed = 0;
  try {
    for (const record of batch) {
      try {
        const detailUrl = record.url;
        if (!tab) tab = await chrome.tabs.create({ url: detailUrl, active: false });
        else tab = await chrome.tabs.update(tab.id, { url: detailUrl, active: false });
        tab = await waitForTabLoad(tab);
        const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPostLengthFromPage, args: [String(record.id)] });
        const detail = result?.[0]?.result;
        if (!detail?.ok || !Number.isFinite(detail.textLength)) throw new Error(t(detail?.error || "未读取到完整正文"));
        const isArticle = Boolean(detail.isArticle);
        const next = { ...record, text: "", isArticle, textLength: detail.textLength, classificationVersion: 4, classificationVerified: true, postType: detail.textLength > 3000 ? "long" : isArticle ? "unknown" : "short" };
        await putLibraryEntry(next, buildSeenRecord(next, next.file || ""));
        checked += 1;
      } catch {
        failed += 1;
        await putLibraryEntry({ ...record, text: "", classificationAttemptedAt: new Date().toISOString() }, buildSeenRecord(record, record.file || ""));
      }
      chrome.runtime.sendMessage({ type: "CLASSIFICATION_PROGRESS", message: tr`正在识别长文：本批已确认 ${checked} 条，暂未读到 ${failed} 条。` }).catch(() => {});
    }
    chrome.runtime.sendMessage({ type: "BOOKMARK_LIBRARY_REPLACED" }).catch(() => {});
    return { ok: true, checked, failed, remaining: Math.max(0, candidates.length - batch.length), message: tr`本批识别 ${checked} 条` + (failed ? tr`，${failed} 条详情暂不可用` : "") + t("。") };
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function isSafeDetailUrl(value) {
  return /^https:\/\/(?:x|twitter)\.com\/[^/]+\/(?:status|article)\/\d+(?:[/?#]|$)/i.test(value || "");
}

async function syncVisibleBookmarks(sender, tweets, bookmarkTotal = null) {
  if (!isBookmarkPageUrl(sender.tab?.url)) return { ok: false, message: t("当前页面不是书签列表。") };
  const { settings = {}, batchImportState = {} } = await getStorage(["settings", "batchImportState"]);
  if (settings.autoSyncEnabled === false) return { ok: true, skipped: true };
  const records = prepareImportBatch(Array.isArray(tweets) ? tweets.slice(0, 50) : []);
  if (Number.isSafeInteger(bookmarkTotal) && bookmarkTotal >= 0) {
    await setStorage({ batchImportState: { ...batchImportState, xTotal: bookmarkTotal, xTotalAt: new Date().toISOString() } });
  }
  if (!records.length) {
    if (Number.isSafeInteger(bookmarkTotal) && bookmarkTotal >= 0) chrome.runtime.sendMessage({ type: "BOOKMARK_LIBRARY_REPLACED" }).catch(() => {});
    return { ok: true, count: 0 };
  }
  const existing = new Map((await listRecords()).map((record) => [record.id, record]));
  for (const record of records) {
    const previous = existing.get(record.id);
    const merged = previous ? mergeIndexedRecord(previous, record) : record;
    await putLibraryEntry({ ...merged, text: "", contentStatus: "url_only" }, buildSeenRecord(record, ""));
  }
  chrome.runtime.sendMessage({ type: "BOOKMARK_LIBRARY_REPLACED" }).catch(() => {});
  return { ok: true, count: records.length };
}

async function runExclusiveImport(operation) {
  if (importRunning) return { ok: false, busy: true, message: t("已有导入任务正在进行，请稍候。") };
  importRunning = true;
  try {
    return await operation();
  } finally {
    importRunning = false;
  }
}

async function ensureAutoSyncAlarm(catchUp = false) {
  const stored = await chrome.storage.local.get(["settings", "nextAutoSyncAt"]);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  await chrome.alarms.clear(AUTO_SYNC_ALARM);
  if (!settings.autoSyncEnabled) {
    await chrome.storage.local.set({ nextAutoSyncAt: null });
    return;
  }
  let next = getNextScheduledTime(settings.autoSyncTime, settings.autoSyncTimeZone, new Date());
  if (catchUp && stored.nextAutoSyncAt && Date.parse(stored.nextAutoSyncAt) <= Date.now()) next = new Date(Date.now() + 5000);
  await chrome.alarms.create(AUTO_SYNC_ALARM, { when: next.getTime() });
  await chrome.storage.local.set({ nextAutoSyncAt: next.toISOString() });
}

async function runAutomaticSync(manual = false) {
  let createdTab = false;
  let tab;
  try {
    await ensureLibraryReady();
    const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get(["settings"]);
    if (!settings.autoSyncEnabled && !manual) return { ok: false, message: t("自动同步已关闭。") };
    const { batchImportState } = await getStorage(["batchImportState"]);
    const tabs = (await chrome.tabs.query({ url: BOOKMARK_TAB_URLS })).filter((item) => item.id !== batchImportState?.tabId && isBookmarkPageUrl(item.url));
    tab = tabs.find((item) => item.active) || tabs[0];
    if (!tab) {
      tab = await chrome.tabs.create({ url: "https://x.com/i/history", active: false });
      createdTab = true;
      tab = await waitForTabLoad(tab);
    }
    await ensureCollector(tab.id);
    const existing = await listRecords();
    const knownIds = existing.map((record) => record.id);
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "COLLECT_X_BOOKMARKS",
      mode: "url_index",
      limit: 1000,
      excludeIds: knownIds,
      postTypeFilter: "all",
    });
    if (!response?.ok) throw new Error(t(response?.error || "X 页面抓取失败。"));
    const recordsById = new Map(existing.map((record) => [record.id, record]));
    const failures = [];
    let saved = 0;
    for (const tweet of response.tweets || []) {
      const previous = recordsById.get(tweet.id);
      const imported = normalizeTweet({ ...tweet, text: "", contentStatus: "url_only", syncStatus: "indexed" });
      const record = mergeImportedRecord(previous, { ...previous, ...imported, file: previous?.file || "", text: "" });
      try {
        await putLibraryEntry(record, buildSeenRecord(record, record.file));
        recordsById.set(record.id, record);
        saved += 1;
      } catch (error) {
        failures.push({ id: record.id, stage: "content", error: error.message, failedAt: new Date().toISOString() });
      }
    }
    const prior = await getStorage(["failedImports"]);
    const savedIds = new Set((response.tweets || []).map((tweet) => tweet.id));
    const nextFailures = (prior.failedImports || []).filter((item) => !savedIds.has(item.id));
    nextFailures.push(...failures);
    const message = tr`同步完成：保存 ${saved} 条新收藏的封面和标题` + (failures.length ? tr`，失败 ${failures.length} 条` : "") + t("。");
    await setStorage({
      failedImports: nextFailures,
      lastAutoSync: { finishedAt: new Date().toISOString(), added: saved, failed: failures.length, message },
    });
    if (saved) chrome.runtime.sendMessage({ type: "BOOKMARK_LIBRARY_REPLACED" }).catch(() => {});
    return { ok: failures.length === 0, message };
  } catch (error) {
    const message = tr`同步失败：${t(error.message)}。确认 X 已登录，并重新加载 X 书签页后重试。`;
    await setStorage({ lastAutoSync: { finishedAt: new Date().toISOString(), added: 0, failed: 0, message } });
    return { ok: false, message };
  } finally {
    if (createdTab && tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function syncBookmarkIndex() {
  let tab;
  let createdTab = false;
  try {
    await ensureLibraryReady();
    const { batchImportState } = await getStorage(["batchImportState"]);
    const tabs = (await chrome.tabs.query({ url: BOOKMARK_TAB_URLS })).filter((item) => item.id !== batchImportState?.tabId && isBookmarkPageUrl(item.url));
    tab = tabs.find((item) => item.active) || tabs[0];
    if (!tab) {
      tab = await chrome.tabs.create({ url: "https://x.com/i/history", active: false });
      createdTab = true;
      tab = await waitForTabLoad(tab);
    }
    await ensureCollector(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "COLLECT_X_BOOKMARKS",
      mode: "url_index",
      limit: 1000,
      postTypeFilter: "all",
    });
    if (!response?.ok) throw new Error(t(response?.error || "无法读取 X 收藏。"));
    const existing = await listRecords();
    const recordsById = new Map(existing.map((record) => [record.id, record]));
    let updated = 0;
    for (const tweet of response.tweets || []) {
      const current = recordsById.get(tweet.id);
      const imported = normalizeTweet({ ...tweet, text: "", contentStatus: "url_only", syncStatus: "indexed" });
      const merged = current ? mergeImportedRecord(current, mergeIndexedRecord(current, imported)) : imported;
      const record = { ...merged, text: "", contentStatus: "url_only", syncStatus: "indexed" };
      await putLibraryEntry(record, buildSeenRecord(record, record.file));
      recordsById.set(record.id, record);
      updated += 1;
    }
    const message = tr`封面与分类已刷新 ${updated} 条，保存在插件本地库。`;
    await setStorage({ lastSync: { type: t("索引与封面刷新"), finishedAt: new Date().toISOString(), message } });
    return { ok: true, message };
  } catch (error) {
    return { ok: false, message: tr`${t(error.message)}。请确认 X 已登录，并重新加载 X 书签页后重试。` };
  } finally {
    if (createdTab && tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function importAllBookmarks(reset = false) {
  let first = true;
  let total = 0;
  for (let batch = 0; batch < 1000; batch += 1) {
    const result = await importBookmarkBatch(reset && first, true);
    first = false;
    if (!result.ok) return result;
    total = result.total;
    if (result.reason === "scroll_stalled") {
      return finishFullImport(tr`导入暂停：X 页面无法继续滚动，已保存 ${total} 条。重新加载 X 后可再次点击继续。`, false);
    }
    if (result.reason === "stalled_at_bottom") {
      return finishFullImport(tr`已保存 ${total} 条；X 页面目前没有加载更多收藏。请核对总数，必要时再次点击继续。`, true);
    }
  }
  return finishFullImport(tr`本次达到扫描上限，已保存 ${total} 条。点击“同步全部收藏”继续。`, false);
}

async function finishFullImport(message, ok) {
  const { batchImportState = {} } = await getStorage(["batchImportState"]);
  const finishedAt = new Date().toISOString();
  await setStorage({ batchImportState: { ...batchImportState, message, finishedAt, finished: ok, historyImportVersion: ok ? 1 : (batchImportState.historyImportVersion || 0) }, lastSync: { type: t("批量导入"), finishedAt, message } });
  chrome.runtime.sendMessage({ type: "BOOKMARK_LIBRARY_REPLACED" }).catch(() => {});
  return { ok, message };
}

async function importBookmarkBatch(reset = false, fullImport = false) {
  let tab = null;
  let createdTab = false;
  let committed = false;
  try {
    await ensureLibraryReady();
    const { batchImportState = {} } = await getStorage(["batchImportState"]);
    const resumeFull = fullImport && batchImportState.fullImport && !batchImportState.finished;
    if (!reset && batchImportState.tabId && (!fullImport || resumeFull)) {
      tab = await chrome.tabs.get(batchImportState.tabId).catch(() => null);
      if (tab && !isBookmarkPageUrl(tab.url)) tab = null;
    }
    if (!tab) {
      tab = await chrome.tabs.create({ url: "https://x.com/i/history", active: false });
      createdTab = true;
      tab = await waitForTabLoad(tab);
    }
    await ensureCollector(tab.id);
    const existing = reset ? [] : await listRecords();
    const existingById = new Map(existing.map((record) => [record.id, record]));
    const scannedIds = fullImport && resumeFull && !createdTab ? (batchImportState.scannedIds || []) : [];
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "COLLECT_X_BOOKMARKS",
      mode: fullImport ? "full_import" : "url_index",
      limit: BATCH_SIZE,
      excludeIds: fullImport ? scannedIds : existing.map((record) => record.id),
      postTypeFilter: "all",
    });
    if (!response?.ok) throw new Error(t(response?.error || "无法读取 X 收藏。"));
    const records = prepareImportBatch(response.tweets || []);
    const explicitlyEmpty = response.meta?.bookmarkTotal === 0;
    if (reset && !records.length && !explicitlyEmpty) throw new Error(t("未读取到收藏，旧插件数据未清空。请检查 X 书签页是否已加载。"));
    if (!reset && !existing.length && !records.length && !explicitlyEmpty) throw new Error(t("未读取到收藏。请检查当前 Chrome 中的 X 登录状态和书签页。"));
    if (reset) {
      await replaceLibraryData(records, Object.fromEntries(records.map((record) => [record.id, buildSeenRecord(record, "")])));
    } else {
      for (const record of records) {
        const previous = existingById.get(record.id);
        const merged = previous ? mergeIndexedRecord(previous, record) : record;
        await putLibraryEntry({ ...merged, text: "", contentStatus: "url_only" }, buildSeenRecord(record, ""));
      }
    }
    committed = true;
    const total = (await listRecords()).length;
    const added = records.filter((record) => !existingById.has(record.id)).length;
    const message = fullImport ? tr`正在读取收藏：插件共有 ${total} 条，本批读取 ${records.length} 条（新增 ${added} 条）。` : records.length
      ? tr`本批导入 ${records.length} 条，插件共有 ${total} 条。点击“导入下一批”继续。`
      : tr`本批没有读到新收藏，插件共有 ${total} 条。可能已到列表末尾或 X 尚在加载，可再次点击继续。`;
    const finishedAt = new Date().toISOString();
    const allScannedIds = fullImport ? [...new Set([...scannedIds, ...records.map((record) => record.id)])] : [];
    const reportedTotal = response.meta?.bookmarkTotal;
    const hasReportedTotal = Number.isSafeInteger(reportedTotal) && reportedTotal >= 0;
    await setStorage({
      batchImportState: {
        tabId: tab.id, message, finishedAt, fullImport, finished: false,
        historyImportVersion: reset ? 0 : (batchImportState.historyImportVersion || 0),
        xTotal: hasReportedTotal ? reportedTotal : (resumeFull && !createdTab ? batchImportState.xTotal ?? null : null),
        xTotalAt: hasReportedTotal ? finishedAt : (resumeFull && !createdTab ? batchImportState.xTotalAt || "" : ""),
        ...(fullImport ? { scannedIds: allScannedIds, scannedCount: allScannedIds.length } : {}),
      },
      lastSync: { type: reset ? t("重置并分批导入") : t("分批导入"), finishedAt, message },
      ...(reset ? { failedImports: [] } : {}),
    });
    if (createdTab && batchImportState.tabId && batchImportState.tabId !== tab.id) await chrome.tabs.remove(batchImportState.tabId).catch(() => {});
    chrome.runtime.sendMessage({ type: "BOOKMARK_LIBRARY_REPLACED" }).catch(() => {});
    return { ok: true, count: records.length, total, reason: response.meta?.reason, message };
  } catch (error) {
    return { ok: false, message: `${t(error.message)}${reset && !committed ? t(" 旧插件收藏未被替换。") : t(" 已保存的收藏仍在插件中，可重试。")}` };
  } finally {
    if (createdTab && !committed && tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function ensureCollector(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PING_X_BOOKMARK_COLLECTOR" });
    if (response?.ok) return;
  } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["extension/content.js"] });
  } catch (error) {
    if (/already been declared/i.test(error.message || "")) throw new Error(t("X 页面仍运行旧版采集脚本，请刷新 X History 页面后重试。"));
    throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function waitForTabLoad(tab) {
  if (tab.status === "complete") return Promise.resolve(tab);
  return new Promise((resolve, reject) => {
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(t("等待 X 页面加载超时。")));
    }, 60_000);
    function onUpdated(tabId, changeInfo, updatedTab) {
      if (finished || tabId !== tab.id || changeInfo.status !== "complete") return;
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(updatedTab);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tab.id).then((current) => {
      if (current.status === "complete") onUpdated(current.id, { status: "complete" }, current);
    }).catch((error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}
