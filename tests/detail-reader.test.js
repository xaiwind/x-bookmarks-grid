import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { t, tr } from "../src/i18n.js";
const initLanguage = () => {};
const localizeDocument = () => {};
import { getBookmarkPostType } from "../src/manager-core.js";
import { buildSeenRecord } from "../src/core.js";

test("article detail reader counts article text without quoted post and returns no body", async () => {
  const root = { cloneNode: () => {
    const clone = { innerText: "主".repeat(3001) + "引用内容", querySelectorAll: () => [{ remove: () => { clone.innerText = "主".repeat(3001); } }] };
    return clone;
  } };
  const document = { querySelector: (selector) => selector.includes("twitterArticleRichTextView") ? root : null, querySelectorAll: () => [] };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, document, location: { pathname: "/user/article/456" }, setTimeout: (fn) => { fn(); } });
  const source = readFileSync(new URL("../extension/detail-reader.js", import.meta.url), "utf8").replace("export async function", "async function");
  vm.runInContext(source, context);
  const result = await context.readPostLengthFromPage("123", true);
  assert.equal(result.ok, true);
  assert.equal(result.isArticle, true);
  assert.equal(result.textLength, 3001);
  assert.equal("text" in result, false);
});

test("post detail reader counts only the main post and refuses folded text", async () => {
  const main = { innerText: "主帖正文", closest: () => null };
  const quote = { innerText: "不计引用", closest: () => ({}) };
  const link = { querySelector: () => ({}), getAttribute: () => "/author/status/123" };
  let collapsed = false;
  const post = { querySelectorAll: (selector) => selector.includes('/article/') ? [] : selector.includes('a[href') ? [link] : selector.includes("tweetText") ? [main, quote] : collapsed ? [main] : [] };
  const document = { querySelector: () => null, querySelectorAll: () => [post] };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, document, location: { pathname: "/author/status/123" }, setTimeout: (fn) => { fn(); } });
  const source = readFileSync(new URL("../extension/detail-reader.js", import.meta.url), "utf8").replace("export async function", "async function");
  vm.runInContext(source, context);
  const result = await context.readPostLengthFromPage("123", false);
  assert.equal(result.ok, true);
  assert.equal(result.textLength, 4);
  assert.equal(result.isArticle, false);
  collapsed = true;
  const unavailable = await context.readPostLengthFromPage("123", false);
  assert.equal(unavailable.ok, false);
});

test("a quoted article's rich text never replaces the main post", async () => {
  const quoted = { cloneNode: () => ({ innerText: "引".repeat(5000), querySelectorAll: () => [] }), closest: () => ({}) };
  const main = { innerText: "自己的短推", closest: () => null };
  const link = { querySelector: () => ({}), getAttribute: () => "/author/status/123" };
  const quoteLink = { href: "https://x.com/other/article/789", closest: () => ({}) };
  const post = { querySelectorAll: (selector) => selector.includes("/article/") ? [quoteLink] : selector.includes('a[href') ? [link] : selector.includes("tweetText") ? [main] : [] };
  const document = { querySelector: (selector) => selector.includes("twitterArticleRichTextView") ? quoted : null, querySelectorAll: () => [post] };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, document, location: { pathname: "/author/status/123", href: "https://x.com/author/status/123" }, URL, setTimeout: (fn) => { fn(); } });
  const source = readFileSync(new URL("../extension/detail-reader.js", import.meta.url), "utf8").replace("export async function", "async function");
  vm.runInContext(source, context);
  const result = await context.readPostLengthFromPage("123", false);
  assert.equal(result.ok, true);
  assert.equal(result.isArticle, false);
  assert.equal(result.textLength, 5);
  assert.equal(result.articleUrl, undefined);
});

test("an unlabelled quote card cannot make a short main post into a long article", async () => {
  const firstAuthor = {};
  const secondAuthor = { compareDocumentPosition: (node) => node.kind === "quote" ? 4 : 2 };
  const main = { kind: "main", innerText: "我的短推", closest: () => null };
  const quotedText = { kind: "quote", innerText: "引".repeat(5000), closest: () => null };
  const statusLink = { kind: "main", closest: () => null, querySelector: () => ({}), getAttribute: () => "/author/status/123" };
  const quoteLink = { kind: "quote", closest: () => null };
  const post = { querySelectorAll: (selector) => selector.includes("User-Name") ? [firstAuthor, secondAuthor] : selector.includes("/article/") ? [quoteLink] : selector.includes('a[href') ? [statusLink] : selector.includes("tweetText") ? [main, quotedText] : [] };
  const document = { querySelector: () => null, querySelectorAll: () => [post] };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, document, location: { pathname: "/author/status/123" }, setTimeout: (fn) => { fn(); } });
  const source = readFileSync(new URL("../extension/detail-reader.js", import.meta.url), "utf8").replace("export async function", "async function");
  vm.runInContext(source, context);
  const result = await context.readPostLengthFromPage("123");
  assert.equal(result.ok, true);
  assert.equal(result.isArticle, false);
  assert.equal(result.textLength, 4);
});

test("an article link of uncertain ownership remains unclassified", async () => {
  const link = { closest: () => null };
  const status = { closest: () => null, querySelector: () => ({}), getAttribute: () => "/author/status/123" };
  const main = { innerText: "可见正文", closest: () => null };
  const post = { querySelectorAll: (selector) => selector.includes("/article/") ? [link] : selector.includes('a[href') ? [status] : selector.includes("tweetText") ? [main] : [] };
  const document = { querySelector: () => null, querySelectorAll: () => [post] };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, document, location: { pathname: "/author/status/123" }, setTimeout: (fn) => { fn(); } });
  const source = readFileSync(new URL("../extension/detail-reader.js", import.meta.url), "utf8").replace("export async function", "async function");
  vm.runInContext(source, context);
  const result = await context.readPostLengthFromPage("123");
  assert.equal(result.ok, false);
});

test("an unmarked quoted status cannot be counted as the main post", async () => {
  const status = { href: "https://x.com/a/status/123", closest: () => null, querySelector: () => ({}), getAttribute: () => "/a/status/123" };
  const quote = { href: "https://x.com/b/status/456", closest: () => null, querySelector: () => ({}), getAttribute: () => "/b/status/456" };
  const quotedText = { innerText: "引用".repeat(3000), closest: () => null };
  const post = { querySelectorAll: (selector) => selector.includes("/article/") ? [] : selector.includes('a[href') ? [status, quote] : selector.includes("tweetText") ? [quotedText] : [] };
  const document = { querySelector: () => null, querySelectorAll: () => [post] };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, document, location: { pathname: "/a/status/123" }, setTimeout: (fn) => { fn(); } });
  const source = readFileSync(new URL("../extension/detail-reader.js", import.meta.url), "utf8").replace("export async function", "async function");
  vm.runInContext(source, context);
  const result = await context.readPostLengthFromPage("123");
  assert.equal(result.ok, false);
});

test("classification saves only the verified count and enables the long filter", async () => {
  const event = { addListener() {} };
  let saved;
  const records = [{ id: "123", url: "https://x.com/author/status/123", title: "文章", text: "", isArticle: true, classificationVersion: 2, postType: "unknown", textLength: 20 }];
  const chrome = { runtime: { onInstalled: event, onStartup: event, onMessage: event, sendMessage: async () => {} }, alarms: { onAlarm: event }, storage: { onChanged: event }, tabs: { create: async () => ({ id: 7, status: "complete" }), remove: async () => {} }, scripting: { executeScript: async () => [{ result: { ok: true, isArticle: true, textLength: 3200 } }] } };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, chrome, getBookmarkPostType, buildSeenRecord, readPostLengthFromPage: () => {}, listRecords: async () => records, putLibraryEntry: async (record) => { saved = record; }, Date });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  const result = await context.classifyPostsBatch();
  assert.equal(result.checked, 1);
  assert.equal(saved.text, "");
  assert.equal(saved.classificationVerified, true);
  assert.equal(saved.textLength, 3200);
  assert.equal(getBookmarkPostType(saved), "long");
});

test("classification opens the bookmarked post instead of a potentially quoted article", async () => {
  const event = { addListener() {} };
  let saved;
  let openedUrl;
  const records = [{ id: "123", url: "https://x.com/author/status/123", articleUrl: "https://x.com/other/article/789", title: "短推", text: "", classificationVersion: 3, classificationVerified: true, isArticle: true, postType: "long", textLength: 5000 }];
  const chrome = { runtime: { onInstalled: event, onStartup: event, onMessage: event, sendMessage: async () => {} }, alarms: { onAlarm: event }, storage: { onChanged: event }, tabs: { create: async (options) => { openedUrl = options.url; return { id: 7, status: "complete" }; }, remove: async () => {} }, scripting: { executeScript: async () => [{ result: { ok: true, isArticle: false, textLength: 20 } }] } };
  const context = vm.createContext({ t, tr, initLanguage, localizeDocument, chrome, getBookmarkPostType, buildSeenRecord, readPostLengthFromPage: () => {}, listRecords: async () => records, putLibraryEntry: async (record) => { saved = record; }, Date });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(source, context);
  const result = await context.classifyPostsBatch();
  assert.equal(result.checked, 1);
  assert.equal(openedUrl, "https://x.com/author/status/123");
  assert.equal(saved.classificationVersion, 4);
  assert.equal(getBookmarkPostType(saved), "short");
});
