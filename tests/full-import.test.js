import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { t, tr } from "../src/i18n.js";
const initLanguage = () => {};
const localizeDocument = () => {};
import { buildSeenRecord, mergeIndexedRecord } from "../src/core.js";
import { prepareImportBatch } from "../src/batch-import-core.js";
import { isBookmarkPageUrl } from "../src/bookmark-route.js";

test("timeline scan excludes nested quoted tweets from the bookmark count", () => {
  const parent = { closest: () => null };
  const outer = { parentElement: parent };
  const nested = { parentElement: { closest: () => outer } };
  const primary = { querySelectorAll: () => [outer, nested] };
  const document = { querySelector: () => primary };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, document, window: {}, chrome: { runtime: { onMessage: { addListener() {} } } }, URL });
  vm.runInContext(readFileSync(new URL("../extension/content.js", import.meta.url), "utf8"), context);
  const result = context.getTimelinePosts();
  assert.equal(result.length, 1);
  assert.equal(result[0], outer);
});

test("full import continues past known items and stops only after reaching a stable bottom", async () => {
  const page = { scrollHeight: 1000, scrollTop: 0 };
  const win = { innerHeight: 100, scrollBy: ({ top }) => { page.scrollTop = Math.min(900, page.scrollTop + top); } };
  const doc = { scrollingElement: page, documentElement: page, querySelector: () => ({}), querySelectorAll: () => [{ tweet: { id: String(Math.floor(page.scrollTop / 90)), postType: "short" } }] };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, window: win, document: doc, chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} } }, URL });
  vm.runInContext(readFileSync(new URL("../extension/content.js", import.meta.url), "utf8"), context);
  vm.runInContext('parseTweetArticle = node => node.tweet; delay = async () => {};', context);
  const result = await context.collectTweets({ limit: 50, mode: "full_import", excludeIds: ["0", "1", "2", "3", "4", "5", "6"], onlyIds: [], operationId: "" });
  assert.equal(result.meta.reason, "stalled_at_bottom");
  assert.ok(result.tweets.some((tweet) => tweet.id === "7"));
  assert.equal(page.scrollTop, 900);
});

test("full import reports a stuck scroll instead of treating it as the end", async () => {
  const page = { scrollHeight: 1000, scrollTop: 0 };
  const win = { innerHeight: 100, scrollBy: () => {} };
  const doc = { scrollingElement: page, documentElement: page, querySelector: () => ({}), querySelectorAll: () => [{ tweet: { id: "1" } }] };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, window: win, document: doc, chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} } }, URL });
  vm.runInContext(readFileSync(new URL("../extension/content.js", import.meta.url), "utf8"), context);
  vm.runInContext('parseTweetArticle = node => node.tweet; delay = async () => {};', context);
  const result = await context.collectTweets({ limit: 50, mode: "full_import", excludeIds: [], onlyIds: [], operationId: "" });
  assert.equal(result.meta.reason, "scroll_stalled");
  assert.equal(result.tweets.length, 1);
});

test("cover extraction prefers main post media over quoted media and ignores avatars", () => {
  const image = (src, quoted = false) => ({ currentSrc: src, src, getAttribute: () => "", closest: () => quoted ? {} : null });
  const imgs = [image("https://pbs.twimg.com/profile_images/avatar"), image("https://pbs.twimg.com/media/quoted?format=jpg", true), image("https://pbs.twimg.com/media/main?format=jpg")];
  const article = { querySelectorAll: (selector) => selector === "img" ? imgs : [] };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, window: {}, location: { href: "https://x.com/i/bookmarks" }, chrome: { runtime: { onMessage: { addListener() {} } } }, URL });
  vm.runInContext(readFileSync(new URL("../extension/content.js", import.meta.url), "utf8"), context);
  const urls = Array.from(context.extractImageUrls(article));
  assert.match(urls[0], /\/media\/main/);
  assert.match(urls[1], /\/media\/quoted/);
  assert.equal(urls.length, 2);
});

test("one click keeps reading across batches and resets only the first batch", async () => {
  const event = { addListener() {} };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, chrome: { runtime: { onInstalled: event, onStartup: event, onMessage: event }, alarms: { onAlarm: event }, storage: { onChanged: event } } });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  vm.runInContext(`
    globalThis.calls = [];
    const replies = [
      { ok: true, total: 50, reason: "limit_reached" },
      { ok: true, total: 65, reason: "max_scroll_attempts" },
      { ok: true, total: 80, reason: "stalled_at_bottom" },
    ];
    importBookmarkBatch = async (reset, full) => { calls.push([reset, full]); return replies.shift(); };
    finishFullImport = async (message, ok) => ({ message, ok });
  `, context);
  const result = await context.importAllBookmarks(true);
  assert.equal(result.ok, true);
  assert.match(result.message, /80 条/);
  assert.deepEqual(JSON.parse(JSON.stringify(context.calls)), [[true, true], [false, true], [false, true]]);
});

test("a full import revisits existing records to refresh covers while retaining scan progress", async () => {
  const event = { addListener() {} };
  const state = { batchImportState: { tabId: 7, fullImport: true, finished: false, scannedIds: ["previous"] } };
  const saved = [{ id: "old", title: "标题", imageUrls: ["https://pbs.twimg.com/media/old"] }];
  let request;
  const chrome = {
    runtime: { onInstalled: event, onStartup: event, onMessage: event, sendMessage: async () => {} },
    alarms: { onAlarm: event }, storage: { onChanged: event },
    tabs: { get: async () => ({ id: 7, url: "https://x.com/i/bookmarks" }), sendMessage: async (_id, message) => { request = message; return { ok: true, tweets: [{ id: "old", title: "标题", imageUrls: ["https://pbs.twimg.com/media/new"] }], meta: { reason: "limit_reached", bookmarkTotal: 153 } }; } },
  };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, chrome, URL, buildSeenRecord, mergeIndexedRecord, prepareImportBatch, isBookmarkPageUrl,
    ensureLibraryReady: async () => {}, getStorage: async () => state,
    setStorage: async (value) => Object.assign(state, value), listRecords: async () => saved,
    putLibraryEntry: async (record) => { saved[0] = record; },
  });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  vm.runInContext("ensureCollector = async () => {};", context);
  const result = await context.importBookmarkBatch(false, true);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(request.excludeIds), ["previous"]);
  assert.deepEqual(Array.from(saved[0].imageUrls), ["https://pbs.twimg.com/media/new", "https://pbs.twimg.com/media/old"]);
  assert.deepEqual(Array.from(state.batchImportState.scannedIds), ["previous", "old"]);
  assert.equal(state.batchImportState.scannedCount, 2);
  assert.equal(state.batchImportState.xTotal, 153);
});

test("visible automatic sync accepts history bookmarks and rejects likes", async () => {
  const event = { addListener() {} };
  const stored = [];
  const chrome = { runtime: { onInstalled: event, onStartup: event, onMessage: event, sendMessage: async () => {} }, alarms: { onAlarm: event }, storage: { onChanged: event } };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, chrome, URL, buildSeenRecord, mergeIndexedRecord, prepareImportBatch, isBookmarkPageUrl,
    getStorage: async () => ({ settings: {} }), listRecords: async () => stored,
    putLibraryEntry: async (record) => stored.push(record),
  });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  const tweet = { id: "42", title: "收藏标题", text: "不保存的正文", imageUrls: ["https://pbs.twimg.com/media/example"] };
  const rejected = await context.syncVisibleBookmarks({ tab: { url: "https://x.com/i/history/likes" } }, [tweet]);
  assert.equal(rejected.ok, false);
  const accepted = await context.syncVisibleBookmarks({ tab: { url: "https://x.com/i/history" } }, [tweet]);
  assert.equal(accepted.ok, true);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, "");
});

test("an explicit zero bookmark total is saved without inventing a local record", async () => {
  const event = { addListener() {} };
  const state = { settings: {}, batchImportState: {} };
  const chrome = { runtime: { onInstalled: event, onStartup: event, onMessage: event, sendMessage: async () => {} }, alarms: { onAlarm: event }, storage: { onChanged: event } };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, chrome, URL, prepareImportBatch, isBookmarkPageUrl, getStorage: async () => state, setStorage: async (value) => Object.assign(state, value) });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  const result = await context.syncVisibleBookmarks({ tab: { url: "https://x.com/i/history" } }, [], 0);
  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
  assert.equal(state.batchImportState.xTotal, 0);
});

test("a reset accepts an explicitly empty X library without treating unknown as empty", async () => {
  const event = { addListener() {} };
  const state = {};
  let replaced = false;
  let reportedTotal = 0;
  const chrome = { runtime: { onInstalled: event, onStartup: event, onMessage: event, sendMessage: async () => {} }, alarms: { onAlarm: event }, storage: { onChanged: event }, tabs: { create: async () => ({ id: 9, status: "complete" }), sendMessage: async () => ({ ok: true, tweets: [], meta: { reason: "stalled_at_bottom", bookmarkTotal: reportedTotal } }), remove: async () => {} } };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, chrome, URL, buildSeenRecord, mergeIndexedRecord, prepareImportBatch, isBookmarkPageUrl,
    ensureLibraryReady: async () => {}, getStorage: async () => state, setStorage: async (value) => Object.assign(state, value),
    listRecords: async () => [], replaceLibraryData: async (records) => { replaced = Array.isArray(records) && records.length === 0; },
  });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  vm.runInContext("ensureCollector = async () => {};", context);
  const result = await context.importBookmarkBatch(true, true);
  assert.equal(result.ok, true);
  assert.equal(replaced, true);
  assert.equal(state.batchImportState.xTotal, 0);
  reportedTotal = null;
  replaced = false;
  const unknown = await context.importBookmarkBatch(true, true);
  assert.equal(unknown.ok, false);
  assert.equal(replaced, false);
});

test("initial history scan is marked attempted only after reaching its stopping point", async () => {
  const event = { addListener() {} };
  const state = { batchImportState: { tabId: 7 } };
  const chrome = { runtime: { onInstalled: event, onStartup: event, onMessage: event, sendMessage: async () => {} }, alarms: { onAlarm: event }, storage: { onChanged: event } };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, chrome, getStorage: async () => state, setStorage: async (value) => Object.assign(state, value) });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  await context.finishFullImport("暂停", false);
  assert.equal(state.batchImportState.historyImportVersion, 0);
  await context.finishFullImport("停止加载", true);
  assert.equal(state.batchImportState.historyImportVersion, 1);
});
