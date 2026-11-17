import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { t, tr } from "../src/i18n.js";
const initLanguage = () => {};
const localizeDocument = () => {};
import * as managerCore from "../src/manager-core.js";
import { describeSyncProgress, hasCompletedFullSync, SYNC_ENGINE_VERSION } from "../src/sync-core.js";

function makeElement(overrides = {}) {
  return {
    value: "", hidden: false, disabled: false, textContent: "", innerHTML: "", options: [], dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, focus() {}, querySelector: () => null, closest: () => null,
    ...overrides,
  };
}

function openManagerWithReply(reply) {
  return openManager({ reply });
}

async function openManager({ records = [{ id: "1", title: "已有旧收藏", imageUrls: [] }], state = {}, reply = { ok: true, started: true, engine: SYNC_ENGINE_VERSION } } = {}) {
  const elements = new Map();
  const chips = ["all", "article"].map((filter) => makeElement({ dataset: { filter } }));
  const document = {
    querySelector: (selector) => { if (!elements.has(selector)) elements.set(selector, makeElement()); return elements.get(selector); },
    querySelectorAll: () => chips,
    addEventListener() {},
  };
  const messages = [];
  const shown = { items: null, message: null };
  const chrome = {
    runtime: { onMessage: { addListener() {} }, sendMessage: async (message) => { messages.push(message); return reply; } },
    storage: { onChanged: { addListener() {} } },
  };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, setupLanguageToggle() {},
    document, chrome, URL, setTimeout, clearTimeout, setInterval: () => 0, window: { scrollTo() {} }, localStorage: { getItem: () => null, setItem() {} },
    ...managerCore, describeSyncProgress, hasCompletedFullSync, SYNC_ENGINE_VERSION, needsTitleBackfill: () => false, displayTitle: (record) => record.title, patchRecord: async () => ({}), createCardMenu: () => ({}), createEditDialog: () => ({}), createToast: () => ({ show() {} }), downloadTextFile() {}, buildPostFilename: () => '', mergeLibraryEntries: async () => ({ added: 0, updated: 0 }), buildBackup: () => '', mergeBackupRecord: (a, b) => a || b, parseBackup: () => ({ records: [], skipped: 0 }), buildPostMarkdown: () => '',
    listRecords: async () => records,
    getStorage: async () => state,
    createMasonry: () => ({ setItems: (items) => { shown.items = items; }, showMessage: (html) => { shown.message = html; } }),
    escapeHtml: (value) => String(value), handleImageError() {}, cardKey: (record) => record.id, createAuthorPicker: () => ({ setAuthors() {}, select() {}, value: () => "" }),
  });
  const source = readFileSync(new URL("../extension/manager.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { messages, elements, shown, context };
}

test("opening the manager shows local records first and then asks the background to sync", async () => {
  const { messages, shown } = await openManager();
  assert.deepEqual(messages.map((message) => message.type), ["LIBRARY_OPENED"]);
  assert.deepEqual(shown.items.map((record) => record.id), ["1"]);
});

test("an empty library shows the import prompt instead of cards", async () => {
  const { shown, elements } = await openManager({ records: [] });
  assert.equal(shown.items, null);
  assert.match(shown.message, /同步全部收藏/);
  assert.match(elements.get("#status").textContent, /目前为空/);
});

test("manager displays X-reported and local counts without inventing a total", async () => {
  const known = await openManager({ state: { batchImportState: { xTotal: 123, scannedCount: 90 } } });
  assert.equal(known.elements.get("#sourceTotal").textContent, "123");
  assert.equal(known.elements.get("#syncedTotal").textContent, "1");
  assert.match(known.elements.get("#sourceCountHint").textContent, /可继续同步/);
  const unknown = await openManager();
  assert.equal(unknown.elements.get("#sourceTotal").textContent, "未获取");
  assert.match(unknown.elements.get("#sourceCountHint").textContent, /无法确认是否全部同步/);
  const estimate = await openManager({ state: { batchImportState: { scannedCount: 90 } } });
  assert.equal(estimate.elements.get("#sourceTotal").textContent, "≥90");
  assert.equal(estimate.elements.get("#sourceLabel").textContent, "X 收藏（已扫描）");
});

test("a running sync disables the buttons and shows its progress, a stale one does not", async () => {
  const now = new Date().toISOString();
  const running = await openManager({ state: { syncProgress: { running: true, mode: "full", scanned: 40, message: "正在读取收藏：已读取 40 条，新增 40 条。", updatedAt: now } } });
  assert.equal(running.elements.get("#syncNow").disabled, true);
  assert.equal(running.elements.get("#syncProgress").hidden, false);
  assert.match(running.elements.get("#status").textContent, /已读取 40 条/);
  const stale = await openManager({ state: { syncProgress: { running: true, mode: "full", scanned: 40, message: "…", updatedAt: "2020-01-01T00:00:00Z" } } });
  assert.equal(stale.elements.get("#syncNow").disabled, false);
  assert.equal(stale.elements.get("#syncProgress").hidden, true);
  assert.match(stale.elements.get("#status").textContent, /中断/);
});

test("the sync button label reflects whether a complete pass has happened", async () => {
  const first = await openManager();
  assert.match(first.elements.get("#syncNow").textContent, /同步全部收藏/);
  const later = await openManager({ state: { librarySyncState: { fullSyncCompletedAt: "2026-01-01T00:00:00Z", engineVersion: 2 }, lastSync: { finishedAt: "2026-01-01T00:00:00Z", message: "已是最新，没有新的收藏。" } } });
  assert.equal(later.elements.get("#syncNow").textContent, "同步新收藏");
  assert.match(later.elements.get("#status").textContent, /已是最新/);
});

test("a page talking to an older background script asks for an extension reload", async () => {
  const { context, elements } = await openManager();
  assert.equal(elements.get("#titleHint").hidden, true);
  const stale = await openManagerWithReply({ ok: true, started: false });
  assert.match(stale.elements.get("#status").textContent, /旧版本/);
  assert.match(stale.elements.get("#titleHint").innerHTML, /reload-extension/);
  assert.ok(context);
});
