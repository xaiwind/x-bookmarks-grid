import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { t, tr } from "../src/i18n.js";
const initLanguage = () => {};
const localizeDocument = () => {};
import { isBookmarkPageUrl } from "../src/bookmark-route.js";

test("injecting the collector twice does not redeclare constants or register duplicate listeners", () => {
  let listeners = 0;
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, window: {}, chrome: { runtime: { onMessage: { addListener() { listeners += 1; } } } }, URL });
  const source = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  assert.doesNotThrow(() => vm.runInContext(source, context));
  assert.equal(listeners, 1);
});

test("background reuses an installed collector and injects only when absent", async () => {
  const event = { addListener() {} };
  let installed = true;
  let injections = 0;
  const chrome = {
    runtime: { onInstalled: event, onStartup: event, onMessage: event },
    alarms: { onAlarm: event }, storage: { onChanged: event },
    tabs: { sendMessage: async () => { if (!installed) throw new Error("no listener"); return { ok: true }; } },
    scripting: { executeScript: async () => { injections += 1; } },
  };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, chrome, setTimeout: (fn) => { fn(); } });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  await context.ensureCollector(1);
  assert.equal(injections, 0);
  installed = false;
  await context.ensureCollector(1);
  assert.equal(injections, 1);
});

test("a stale page with the old const declaration gives a refresh instruction", async () => {
  const event = { addListener() {} };
  const chrome = {
    runtime: { onInstalled: event, onStartup: event, onMessage: event }, alarms: { onAlarm: event }, storage: { onChanged: event },
    tabs: { sendMessage: async () => { throw new Error("no listener"); } },
    scripting: { executeScript: async () => { throw new Error("Identifier 'MAX_URL_SCROLL_ATTEMPTS' has already been declared"); } },
  };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, chrome, setTimeout });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  await assert.rejects(context.ensureCollector(1), /刷新.*History/);
});

test("bookmark route accepts history and legacy paths but rejects likes", () => {
  for (const url of ["https://x.com/i/history", "https://x.com/i/history/bookmarks/123", "https://twitter.com/i/bookmarks", "https://x.com/i/bookmarks/123"]) assert.equal(isBookmarkPageUrl(url), true, url);
  for (const url of ["https://x.com/i/history/likes", "https://x.com/i/history/likes/123", "https://example.com/i/history", "https://x.com/i/history-other"]) assert.equal(isBookmarkPageUrl(url), false, url);
});

test("history collector refuses the selected likes tab", () => {
  const selected = { textContent: "Likes", getAttribute: (name) => name === "href" ? "/i/history/likes" : "" };
  const document = { querySelectorAll: () => [selected] };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, document, location: { pathname: "/i/history" }, window: {}, chrome: { runtime: { onMessage: { addListener() {} } } }, URL });
  vm.runInContext(readFileSync(new URL("../extension/content.js", import.meta.url), "utf8"), context);
  assert.equal(context.isLikesTimeline(), true);
  selected.textContent = "Bookmarks";
  selected.getAttribute = () => "/i/history";
  assert.equal(context.isLikesTimeline(), false);
  selected.textContent = "喜欢的内容";
  assert.equal(context.isLikesTimeline(), true);
});

test("bookmark total only accepts an explicit exact count in the selected tab or heading", () => {
  const nodes = [{ textContent: "书签 1,234", getAttribute: () => "" }];
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, document: { querySelectorAll: () => nodes }, window: {}, chrome: { runtime: { onMessage: { addListener() {} } } }, URL });
  vm.runInContext(readFileSync(new URL("../extension/content.js", import.meta.url), "utf8"), context);
  assert.equal(context.extractBookmarkTotal(), 1234);
  nodes[0].textContent = "书签";
  assert.equal(context.extractBookmarkTotal(), null);
  nodes[0].textContent = "书签 1.2万";
  assert.equal(context.extractBookmarkTotal(), null);
});

test("visiting history automatically syncs visible bookmarks and ignores likes", async () => {
  const timers = [];
  const listeners = {};
  const messages = [];
  const location = { pathname: "/i/history" };
  const document = { documentElement: {}, querySelectorAll: (selector) => selector.includes('article[data-testid="tweet"]') ? [{ tweet: { id: "1", title: "标题", imageUrls: [] } }] : [] };
  class FakeObserver { observe() {} }
  const window = { addEventListener: (name, callback) => { listeners[name] = callback; } };
  const chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: async (message) => { messages.push(message); return { ok: true }; } } };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, document, location, window, chrome, URL, MutationObserver: FakeObserver, setTimeout: (fn) => { timers.push(fn); return timers.length; } });
  vm.runInContext(readFileSync(new URL("../extension/content.js", import.meta.url), "utf8"), context);
  vm.runInContext("parseTweetArticle = node => node.tweet;", context);
  await timers.shift()();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "SYNC_VISIBLE_BOOKMARKS");
  location.pathname = "/i/history/likes";
  listeners.scroll();
  await timers.shift()();
  assert.equal(messages.length, 1);
});
