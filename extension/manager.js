import { bookmarkSourceDisplay, countBookmarkTypes, describeBookmarkCounts, filterBookmarkRecords, listTopAuthors, sortBookmarkRecords, summarizeBookmarkCounts } from "../src/manager-core.js";
import { describeSyncProgress, hasCompletedFullSync, SYNC_ENGINE_VERSION } from "../src/sync-core.js";
import { displayTitle, needsTitleBackfill } from "../src/core.js";
import { buildPostFilename, buildPostMarkdown } from "../src/post-export.js";
import { listRecords, mergeLibraryEntries, patchRecord } from "./bookmark-repository.js";
import { buildBackup, mergeBackupRecord, parseBackup } from "../src/backup-core.js";
import { createCardMenu, createEditDialog, createToast, downloadTextFile } from "./card-actions.js";
import { getStorage } from "./chrome-storage.js";
import { createAuthorPicker } from "./author-picker.js";
import { cardKey, createMasonry, handleImageError } from "./manager-view.js";
import { initLanguage, localizeDocument, t, tr } from "../src/i18n.js";
import { setupLanguageToggle } from "./language-toggle.js";

initLanguage();
localizeDocument();

const FILTER_DEBOUNCE_MS = 160;
const RELOAD_THROTTLE_MS = 3000;
const PROGRESS_TICK_MS = 5000;
const BUSY_RETRY_MS = 4000;
const SORT_PREFERENCE_KEY = "xBookmarkLibrary.sort";
const DEFAULT_SORT = "bookmarked";
const VIRAL_VIEW_COUNT = 1_000_000;
const STORAGE_KEYS = ["lastSync", "lastAutoSync", "batchImportState", "syncProgress", "librarySyncState"];

const $ = (selector) => document.querySelector(selector);
const elements = {
  query: $("#query"), author: $("#author"), authorList: $("#authorList"), authorClear: $("#authorClear"), fromDate: $("#fromDate"), toDate: $("#toDate"),
  hasLinks: $("#hasLinks"), viralToggle: $("#viralToggle"), sort: $("#sort"), clearFilters: $("#clearFilters"), typeFilters: [...document.querySelectorAll(".type-filter")],
  syncNow: $("#syncNow"), fullRescan: $("#fullRescan"), exportBackup: $("#exportBackup"), importBackup: $("#importBackup"), backupFile: $("#backupFile"), stopSync: $("#stopSync"), status: $("#status"), count: $("#count"),
  sourceTotal: $("#sourceTotal"), sourceLabel: $("#sourceLabel"), syncedTotal: $("#syncedTotal"),
  sourceCountHint: $("#sourceCountHint"), titleHint: $("#titleHint"), progress: $("#syncProgress"), progressBar: $("#syncProgressBar"), rows: $("#rows"),
};

const masonry = createMasonry(elements.rows);
const authorPicker = createAuthorPicker({ input: elements.author, list: elements.authorList, clearButton: elements.authorClear, onChange: () => render({ reset: true }) });
const ALL_AUTHORS = Number.MAX_SAFE_INTEGER;
const toast = createToast($("#toast"));
const editDialog = createEditDialog({ dialog: $("#editDialog"), onSave: saveEdit });
createCardMenu({ menu: $("#cardMenu"), cards: elements.rows, onAction: handleCardAction });
let records = [];
let storage = {};
let activeType = "all";
let viralOnly = false;
let lastSignature = "";
let filterTimer;
let reloadTimer;
let lastReloadAt = 0;
let statusOverride = "";
let titleFillRunning = false;
let backgroundOutdated = false;

elements.sort.value = readSortPreference();
setupLanguageToggle($("#languageToggle"), { onError: (error) => toast.show(tr`切换语言失败：${error.message}`) });
elements.syncNow.addEventListener("click", () => startSync("auto"));
elements.fullRescan.addEventListener("click", () => startSync("full"));
elements.stopSync.addEventListener("click", () => chrome.runtime.sendMessage({ type: "STOP_LIBRARY_SYNC" }).catch(() => {}));
elements.clearFilters.addEventListener("click", clearFilters);
elements.exportBackup.addEventListener("click", exportBackup);
elements.importBackup.addEventListener("click", () => elements.backupFile.click());
elements.backupFile.addEventListener("change", importBackup);
elements.sort.addEventListener("change", () => {
  saveSortPreference(elements.sort.value);
  render({ reset: true });
});
elements.viralToggle.addEventListener("click", () => setViralOnly(!viralOnly));
for (const element of [elements.query, elements.author, elements.fromDate, elements.toDate, elements.hasLinks]) {
  element.addEventListener("input", scheduleFilterRender);
  element.addEventListener("change", scheduleFilterRender);
}
for (const button of elements.typeFilters) button.addEventListener("click", () => selectType(button.dataset.filter));
elements.rows.addEventListener("error", handleImageError, true);
elements.rows.addEventListener("click", handleRowsClick);
elements.titleHint.addEventListener("click", (event) => {
  if (event.target.closest("[data-action='fill-titles']")) fillMissingTitles();
  if (event.target.closest("[data-action='reload-extension']")) chrome.runtime.reload();
});
document.addEventListener("keydown", handleShortcut);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "BOOKMARK_LIBRARY_REPLACED") scheduleReload();
});
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local" || !STORAGE_KEYS.some((key) => changes[key])) return;
  storage = { ...storage, ...Object.fromEntries(STORAGE_KEYS.filter((key) => changes[key]).map((key) => [key, changes[key].newValue])) };
  renderSyncState();
});
setInterval(renderSyncState, PROGRESS_TICK_MS);
init();

async function init() {
  await loadLocalRecords({ reset: true });
  try {
    const opened = await chrome.runtime.sendMessage({ type: "LIBRARY_OPENED" });
    // Refreshing this page does not restart the background script; only reloading the extension does.
    backgroundOutdated = opened?.engine !== SYNC_ENGINE_VERSION;
  } catch (error) {
    setStatusOverride(tr`无法启动自动同步：${error.message}`);
  }
  if (backgroundOutdated) {
    setStatusOverride(t("插件后台还是旧版本，新功能没有生效。请重新加载插件。"));
    renderTitleHint();
    return;
  }
  if (records.some(needsTitleBackfill)) fillMissingTitles();
}

async function loadLocalRecords({ reset = false } = {}) {
  lastReloadAt = Date.now();
  try {
    const [savedRecords, stored] = await Promise.all([listRecords(), getStorage(STORAGE_KEYS)]);
    // Deleted posts stay stored but hidden, so a later sync does not bring them back.
    records = savedRecords.filter((record) => !record.hidden);
    storage = stored;
    renderAuthors();
    renderSyncState();
    render({ reset });
  } catch (error) {
    setStatusOverride(tr`读取插件本地收藏失败：${error.message}`);
  }
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  const wait = Math.max(0, RELOAD_THROTTLE_MS - (Date.now() - lastReloadAt));
  reloadTimer = setTimeout(() => loadLocalRecords(), wait);
}

async function startSync(mode) {
  statusOverride = "";
  try {
    const result = await chrome.runtime.sendMessage({ type: "START_LIBRARY_SYNC", mode });
    if (!result?.ok) throw new Error(result?.message || t("无法开始同步"));
    if (result.alreadyRunning) setStatusOverride(t("已有同步任务在进行，请稍候。"));
  } catch (error) {
    setStatusOverride(tr`同步失败：${error.message}`);
  }
}

function renderSyncState() {
  const counts = summarizeBookmarkCounts(records, storage.batchImportState);
  const source = bookmarkSourceDisplay(counts);
  elements.sourceTotal.textContent = source.value;
  elements.sourceLabel.textContent = source.label;
  elements.syncedTotal.textContent = counts.syncedTotal.toLocaleString();
  elements.sourceCountHint.textContent = describeBookmarkCounts(counts);

  const progress = describeSyncProgress(storage.syncProgress, { knownTotal: counts.sourceTotal });
  elements.progress.hidden = !progress.active;
  elements.progress.classList.toggle("indeterminate", progress.active && progress.percent === null);
  elements.progressBar.style.width = progress.percent === null ? "" : `${progress.percent}%`;
  elements.syncNow.disabled = progress.active;
  elements.fullRescan.disabled = progress.active;
  elements.syncNow.textContent = progress.active ? t("同步中…") : hasCompletedFullSync(storage.librarySyncState) ? t("同步新收藏") : t("＋ 同步全部收藏");
  if (progress.active) statusOverride = "";
  elements.status.textContent = statusOverride || progress.text || defaultStatus();
}

function defaultStatus() {
  if (!records.length) return t("插件本地收藏目前为空。点击“同步全部收藏”开始导入。");
  const latest = [storage.lastAutoSync, storage.lastSync].filter(Boolean)
    .sort((a, b) => (Date.parse(b.finishedAt || "") || 0) - (Date.parse(a.finishedAt || "") || 0))[0];
  return latest?.message || tr`已加载本地收藏 ${records.length.toLocaleString()} 条。`;
}

function setStatusOverride(message) {
  statusOverride = message;
  renderSyncState();
}

function renderAuthors() {
  authorPicker.setAuthors(listTopAuthors(records, ALL_AUTHORS));
}

function currentFilters() {
  return { query: elements.query.value, author: authorPicker.value(), fromDate: elements.fromDate.value, toDate: elements.toDate.value, hasLinks: elements.hasLinks.value, minViews: viralOnly ? VIRAL_VIEW_COUNT : "", type: activeType };
}

function hasActiveFilters(filters) {
  return Boolean(filters.query.trim() || filters.author.trim() || filters.fromDate || filters.toDate || filters.hasLinks || filters.minViews || filters.type !== "all");
}

function scheduleFilterRender() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => render({ reset: true }), FILTER_DEBOUNCE_MS);
}

function selectType(type) {
  activeType = type;
  for (const button of elements.typeFilters) {
    const selected = button.dataset.filter === type;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  render({ reset: true });
}

function setViralOnly(next) {
  viralOnly = next;
  renderViralToggle();
  render({ reset: true });
}

function renderViralToggle() {
  elements.viralToggle.classList.toggle("active", viralOnly);
  elements.viralToggle.setAttribute("aria-pressed", String(viralOnly));
}

function clearFilters() {
  for (const element of [elements.query, elements.fromDate, elements.toDate, elements.hasLinks]) element.value = "";
  viralOnly = false;
  renderViralToggle();
  authorPicker.select("");
  selectType("all");
}

function render({ reset = false } = {}) {
  const filters = currentFilters();
  const sorted = sortBookmarkRecords(filterBookmarkRecords(records, filters), elements.sort.value);
  // Counts follow the other filters, so the categories always add up to the number under "全部".
  const typeCounts = countBookmarkTypes(filterBookmarkRecords(records, { ...filters, type: "all" }));
  for (const button of elements.typeFilters) {
    const badge = button.querySelector("small");
    if (badge) badge.textContent = typeCounts[button.dataset.filter]?.toLocaleString() ?? "";
  }
  const viralBadge = elements.viralToggle.querySelector("small");
  if (viralBadge) viralBadge.textContent = filterBookmarkRecords(records, { ...filters, minViews: VIRAL_VIEW_COUNT }).length.toLocaleString();
  elements.count.textContent = `${sorted.length.toLocaleString()} / ${records.length.toLocaleString()}`;
  elements.clearFilters.hidden = !hasActiveFilters(filters);
  renderTitleHint();

  const signature = sorted.map(cardKey).join("\n");
  if (!reset && signature === lastSignature) return;
  lastSignature = signature;
  if (sorted.length) masonry.setItems(sorted, { keepRendered: !reset });
  else masonry.showMessage(emptyState());
}

function renderTitleHint() {
  if (backgroundOutdated) {
    elements.titleHint.hidden = false;
    elements.titleHint.innerHTML = `${t("刷新本页不会更新插件后台。")}<button type="button" class="link-button" data-action="reload-extension">${t("立即重新加载插件")}</button>${t("（本页会自动关闭，重新打开即可；本地收藏不受影响）")}`;
    return;
  }
  const missing = records.filter(needsTitleBackfill).length;
  elements.titleHint.hidden = !missing;
  if (!missing) return;
  elements.titleHint.innerHTML = titleFillRunning
    ? tr`正在逐条打开原帖读取标题，还剩 ${missing.toLocaleString()} 条…`
    : `${tr`${missing.toLocaleString()} 条收藏还没有标题。它们已不在 X 收藏夹里，同步更新不到；打开本页时会自动逐条访问原帖读取，只有图片或视频的短帖本来就没有标题，会标成“无文字”；读不到的 6 小时后再试。`}<button type="button" class="link-button" data-action="fill-titles">${t("现在补全")}</button>`;
}

async function fillMissingTitles() {
  if (titleFillRunning) return;
  titleFillRunning = true;
  let filled = 0;
  let untitled = 0;
  let failed = 0;
  renderTitleHint();
  try {
    for (;;) {
      setStatusOverride(tr`正在补全标题：已补 ${filled} 条` + (untitled ? tr`，${untitled} 条是无文字的短帖` : "") + (failed ? tr`，${failed} 条读不到` : "") + t("。只保存标题，不保存正文。"));
      const result = await chrome.runtime.sendMessage({ type: "FILL_MISSING_TITLES_BATCH" });
      if (!result?.ok && result?.busy) {
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
        continue;
      }
      if (!result) throw new Error(t("插件后台没有响应这个功能，请到 chrome://extensions 重新加载插件"));
      if (!result.ok) throw new Error(result.message || t("补全失败"));
      filled += result.filled || 0;
      untitled += result.untitled || 0;
      failed += result.failed || 0;
      await loadLocalRecords();
      if (!result.remaining || !(result.filled || result.untitled || result.failed)) break;
    }
    setStatusOverride(tr`标题补全结束：补上 ${filled} 条` + (untitled ? tr`，${untitled} 条是只有图片或视频的短帖，本来就没有标题` : "") + (failed ? tr`，${failed} 条读不到（帖子可能已删除或不可见）` : "") + t("。"));
  } catch (error) {
    setStatusOverride(tr`标题补全暂停：${error.message}`);
  } finally {
    titleFillRunning = false;
    renderTitleHint();
  }
}

function handleCardAction(action, id) {
  const record = records.find((item) => item.id === id);
  if (!record) return;
  if (action === "open") window.open(record.url, "_blank", "noopener");
  if (action === "sync") syncOne(record);
  if (action === "edit") editDialog.open(record, displayTitle(record), !needsTitleBackfill({ ...record, untitled: false, hidden: false }));
  if (action === "download") downloadOne(record);
  if (action === "delete") deleteOne(record);
}

async function askBackground(message, busyText) {
  for (;;) {
    setStatusOverride(busyText);
    const result = await chrome.runtime.sendMessage(message);
    if (!result) throw new Error(t("插件后台没有响应这个功能，请到 chrome://extensions 重新加载插件"));
    if (!result.ok && result.busy) {
      setStatusOverride(t("正在等待当前同步结束…"));
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      continue;
    }
    return result;
  }
}

async function syncOne(record) {
  try {
    const result = await askBackground({ type: "SYNC_SINGLE_RECORD", id: record.id }, tr`正在访问原帖同步：${displayTitle(record)}`);
    await loadLocalRecords();
    setStatusOverride(result.message || (result.ok ? t("已同步。") : t("同步失败。")));
  } catch (error) {
    setStatusOverride(tr`同步失败：${error.message}`);
  }
}

async function saveEdit(id, { title, note }) {
  const current = records.find((item) => item.id === id);
  const keepsXTitle = !title || title === displayTitle({ ...current, titleEdited: false });
  await patchRecord(id, keepsXTitle && !current?.titleEdited ? { note } : { note, title: title || current?.title || "", titleEdited: Boolean(title) });
  await loadLocalRecords();
  setStatusOverride(t("已保存修改。"));
}

async function downloadOne(record) {
  try {
    const result = await askBackground({ type: "READ_POST_MARKDOWN", id: record.id }, tr`正在打开原帖读取正文：${displayTitle(record)}`);
    const body = result.ok ? result.markdown : "";
    const title = record.titleEdited ? record.title : result.title || displayTitle(record);
    downloadTextFile(buildPostFilename(record, title), buildPostMarkdown(record, { body, title }));
    setStatusOverride(result.ok ? tr`已下载：${title}` : tr`没有读到正文（${result.message || t("原因未知")}），已下载只含标题、链接和封面的文件。`);
  } catch (error) {
    setStatusOverride(tr`下载失败：${error.message}`);
  }
}

async function deleteOne(record) {
  try {
    await patchRecord(record.id, { hidden: true, hiddenAt: new Date().toISOString() });
    await loadLocalRecords();
    toast.show(tr`已删除：${displayTitle(record)}`, {
      label: t("撤销"),
      run: async () => {
        try {
          await patchRecord(record.id, { hidden: false });
          await loadLocalRecords();
        } catch (error) {
          setStatusOverride(tr`撤销失败：${error.message}`);
        }
      },
    });
  } catch (error) {
    setStatusOverride(tr`删除失败：${error.message}`);
  }
}

async function exportBackup() {
  try {
    const all = await listRecords();
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    downloadTextFile(`x-bookmarks-backup-${stamp}.json`, buildBackup(all, now), "application/json");
    setStatusOverride(tr`已导出 ${all.length.toLocaleString()} 条收藏的备份文件。`);
  } catch (error) {
    setStatusOverride(tr`导出备份失败：${error.message}`);
  }
}

async function importBackup() {
  const file = elements.backupFile.files?.[0];
  elements.backupFile.value = "";
  if (!file) return;
  try {
    const backup = parseBackup(await file.text());
    const saved = await mergeLibraryEntries(backup.records, mergeBackupRecord);
    await loadLocalRecords({ reset: true });
    setStatusOverride(tr`导入完成：新增 ${saved.added.toLocaleString()} 条，已有的 ${saved.updated.toLocaleString()} 条只补充了缺少的内容` + (backup.skipped ? tr`，跳过 ${backup.skipped} 条无效记录` : "") + t("。"));
  } catch (error) {
    setStatusOverride(tr`导入备份失败：${error.message}`);
  }
}

function emptyState() {
  if (!records.length) {
    return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">✳</span><strong>${t("给好内容一个安静的地方")}</strong><span>${t("登录 X 后点击同步，插件会一次读取你的全部收藏的封面与标题。")}</span><button type="button" class="empty-action" data-action="import">${t("同步全部收藏")}</button></div>`;
  }
  return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌕</span><strong>${t("没有找到匹配的收藏")}</strong><span>${t("试试其他关键词，或清除筛选重新浏览。")}</span><button type="button" class="empty-action" data-action="clear">${t("清除筛选")}</button></div>`;
}

function handleRowsClick(event) {
  const author = event.target.closest("[data-author]")?.dataset.author;
  if (author) {
    authorPicker.select(author);
    render({ reset: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "clear") clearFilters();
  if (action === "import") startSync("auto");
}

function handleShortcut(event) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !typing) {
    event.preventDefault();
    elements.query.focus();
  }
  if (event.key === "Escape" && document.activeElement === elements.query && elements.query.value) {
    elements.query.value = "";
    render({ reset: true });
  }
}

function readSortPreference() {
  try {
    const saved = localStorage.getItem(SORT_PREFERENCE_KEY);
    return [...elements.sort.options].some((option) => option.value === saved) ? saved : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

function saveSortPreference(value) {
  try {
    localStorage.setItem(SORT_PREFERENCE_KEY, value);
  } catch {
    // Storage can be unavailable in restricted profiles; the sort still applies for this visit.
  }
}
