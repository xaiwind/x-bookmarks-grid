import { getStorage, setStorage } from "./chrome-storage.js";
import { listRecords } from "./bookmark-repository.js";
import { bookmarkSourceDisplay, describeBookmarkCounts, summarizeBookmarkCounts } from "../src/manager-core.js";
import { describeSyncProgress, hasCompletedFullSync } from "../src/sync-core.js";
import { initLanguage, localizeDocument, t, tr } from "../src/i18n.js";
import { setupLanguageToggle } from "./language-toggle.js";

initLanguage();
localizeDocument();

const DEFAULT_SETTINGS = {
  autoSyncEnabled: true,
  autoSyncTime: "01:00",
  autoSyncTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei",
};
const PROGRESS_TICK_MS = 5000;
const COUNT_REFRESH_MS = 2000;
const STATE_KEYS = ["syncProgress", "batchImportState", "librarySyncState", "lastAutoSync", "nextAutoSyncAt"];
const $ = (selector) => document.querySelector(selector);
const elements = {
  openX: $("#openX"), importBatch: $("#importBatch"), fullRescan: $("#fullRescan"), stopSync: $("#stopSync"), resetAndReimport: $("#resetAndReimport"),
  openManager: $("#openManager"), autoSyncEnabled: $("#autoSyncEnabled"), autoSyncTime: $("#autoSyncTime"), autoSyncTimeZone: $("#autoSyncTimeZone"),
  autoSyncStatus: $("#autoSyncStatus"), recordCount: $("#recordCount"), sourceTotal: $("#sourceTotal"), sourceLabel: $("#sourceLabel"),
  sourceCountHint: $("#sourceCountHint"), coverCount: $("#coverCount"), status: $("#status"), progress: $("#syncProgress"), progressBar: $("#syncProgressBar"),
};

let state = {};
let knownTotal = null;
let statusOverride = "";
let resetRunning = false;
let countTimer;

setupLanguageToggle($("#languageToggle"), { onError: (error) => setStatus(tr`切换语言失败：${error.message}`) });
elements.openX.addEventListener("click", () => chrome.tabs.create({ url: "https://x.com/i/history", active: true }));
elements.openManager.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.importBatch.addEventListener("click", () => startSync("auto"));
elements.fullRescan.addEventListener("click", () => startSync("full"));
elements.stopSync.addEventListener("click", () => chrome.runtime.sendMessage({ type: "STOP_LIBRARY_SYNC" }).catch(() => {}));
elements.resetAndReimport.addEventListener("click", resetAndReimport);
for (const element of [elements.autoSyncEnabled, elements.autoSyncTime, elements.autoSyncTimeZone]) {
  element.addEventListener("change", saveAutoSyncSettings);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !STATE_KEYS.some((key) => changes[key])) return;
  state = { ...state, ...Object.fromEntries(STATE_KEYS.filter((key) => changes[key]).map((key) => [key, changes[key].newValue])) };
  renderState();
  scheduleCountRefresh();
});
setInterval(renderState, PROGRESS_TICK_MS);
init();

async function init() {
  try {
    const stored = await getStorage(["settings", ...STATE_KEYS]);
    const merged = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    elements.autoSyncEnabled.checked = merged.autoSyncEnabled !== false;
    elements.autoSyncTime.value = merged.autoSyncTime || DEFAULT_SETTINGS.autoSyncTime;
    elements.autoSyncTimeZone.value = merged.autoSyncTimeZone || DEFAULT_SETTINGS.autoSyncTimeZone;
    state = stored;
    await refreshCounts();
    renderState();
    await chrome.runtime.sendMessage({ type: "LIBRARY_OPENED" });
  } catch (error) {
    setStatus(tr`读取插件数据失败：${error.message}`);
  }
}

async function startSync(mode) {
  statusOverride = "";
  try {
    const result = await chrome.runtime.sendMessage({ type: "START_LIBRARY_SYNC", mode });
    if (!result?.ok) throw new Error(result?.message || t("无法开始同步"));
    if (result.alreadyRunning) setStatus(t("已有同步任务在进行，请稍候。"));
  } catch (error) {
    setStatus(tr`同步失败：${error.message}`);
  }
}

function renderState() {
  const progress = describeSyncProgress(state.syncProgress, { knownTotal });
  const busy = progress.active || resetRunning;
  elements.progress.hidden = !progress.active;
  elements.progress.classList.toggle("indeterminate", progress.active && progress.percent === null);
  elements.progressBar.style.width = progress.percent === null ? "" : `${progress.percent}%`;
  for (const button of [elements.importBatch, elements.fullRescan, elements.resetAndReimport]) button.disabled = busy;
  elements.importBatch.textContent = progress.active ? t("同步中…") : hasCompletedFullSync(state.librarySyncState) ? t("同步新收藏") : t("＋ 同步全部收藏");
  if (progress.active) statusOverride = "";
  elements.status.textContent = statusOverride || progress.text || state.batchImportState?.message || t("点击“同步全部收藏”，一次读取你在 X 上的全部收藏。");
  const lastText = state.lastAutoSync?.message || t("尚无定时同步记录");
  const nextText = elements.autoSyncEnabled.checked && state.nextAutoSyncAt ? tr`下次：${new Date(state.nextAutoSyncAt).toLocaleString()}` : t("自动同步已关闭");
  elements.autoSyncStatus.textContent = `${lastText} · ${nextText}`;
}

function setStatus(message) {
  statusOverride = message;
  renderState();
}

function scheduleCountRefresh() {
  if (countTimer) return;
  countTimer = setTimeout(() => {
    countTimer = null;
    refreshCounts().catch((error) => setStatus(tr`读取收藏数量失败：${error.message}`));
  }, COUNT_REFRESH_MS);
}

async function refreshCounts() {
  const records = (await listRecords()).filter((record) => !record.hidden);
  const counts = summarizeBookmarkCounts(records, state.batchImportState);
  const source = bookmarkSourceDisplay(counts);
  knownTotal = counts.sourceTotal;
  elements.sourceTotal.textContent = source.value;
  elements.sourceLabel.textContent = source.label;
  elements.recordCount.textContent = counts.syncedTotal.toLocaleString();
  elements.coverCount.textContent = records.filter((record) => (record.imageUrls || []).length > 0).length.toLocaleString();
  elements.sourceCountHint.textContent = describeBookmarkCounts(counts);
}

async function resetAndReimport() {
  const confirmed = confirm(t("将清空插件里保存的全部收藏（包括备注和改过的标题），然后重新同步。成功读到第一批后才会替换旧数据。已经不在 X 收藏夹里的旧收藏清空后找不回来。\n\n如果只是想刷新封面和标题，请改用“完整重扫”，它不会删除任何数据。\n\n确定要清空并重建吗？"));
  if (!confirmed) return;
  resetRunning = true;
  setStatus(t("正在读取收藏，成功读取第一批后会替换插件本地资料并继续同步…"));
  try {
    const result = await chrome.runtime.sendMessage({ type: "RESET_AND_REIMPORT_BOOKMARKS" });
    if (!result?.ok) throw new Error(result?.message || t("重新导入失败"));
    setStatus(result.message);
  } catch (error) {
    setStatus(tr`同步失败：${error.message}`);
  } finally {
    resetRunning = false;
    await refreshCounts().catch(() => {});
    renderState();
  }
}

async function saveAutoSyncSettings() {
  try {
    const { settings = {} } = await getStorage(["settings"]);
    const next = {
      ...settings,
      autoSyncEnabled: elements.autoSyncEnabled.checked,
      autoSyncTime: elements.autoSyncTime.value || DEFAULT_SETTINGS.autoSyncTime,
      autoSyncTimeZone: elements.autoSyncTimeZone.value.trim() || DEFAULT_SETTINGS.autoSyncTimeZone,
    };
    await setStorage({ settings: next });
    await chrome.runtime.sendMessage({ type: "UPDATE_AUTO_SYNC", settings: next });
    const refreshed = await getStorage(["lastAutoSync", "nextAutoSyncAt"]);
    state = { ...state, ...refreshed };
    renderState();
  } catch (error) {
    setStatus(tr`保存设置失败：${error.message}`);
  }
}
