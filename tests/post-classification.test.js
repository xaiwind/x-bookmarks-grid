import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { t, tr } from "../src/i18n.js";
const initLanguage = () => {};
const localizeDocument = () => {};
import { normalizeTweet, mergeIndexedRecord } from "../src/core.js";
import { getBookmarkPostType, isRecognizedArticle } from "../src/manager-core.js";

const context = vm.createContext({ t, tr, initLanguage, localizeDocument, window: {}, chrome: { runtime: { onMessage: { addListener() {} } } }, URL });
vm.runInContext(readFileSync(new URL("../extension/content.js", import.meta.url), "utf8"), context);

test("only complete visible text under the limit is classified as short", () => {
  assert.equal(context.inferPostType(3001, false, false), "long");
  assert.equal(context.inferPostType(3000, false, true), "short");
  assert.equal(context.inferPostType(300, false, false), "unknown");
  assert.equal(context.inferPostType(0, true, false), "unknown");
  assert.equal(context.inferPostType(4000, true, true), "unknown");
});

test("quoted article links do not turn the main post into an article", () => {
  const quoted = { href: "https://x.com/example/article/123", closest: () => ({}), matches: () => false };
  const main = { href: "https://x.com/example/article/456", closest: () => null, matches: () => false };
  assert.equal(context.isNativeArticle({ querySelectorAll: () => [quoted] }), false);
  assert.equal(context.isNativeArticle({ querySelectorAll: () => [main] }), true);
});

test("article media links resolve to their article rather than the media viewer", () => {
  const main = { href: "https://x.com/leaf_sanren/article/2117240850011086985/media/2117220533452640256", closest: () => null };
  assert.equal(context.extractArticleUrl({ querySelectorAll: () => [main] }), "https://x.com/leaf_sanren/article/2117240850011086985");
  assert.equal(normalizeTweet({ id: "9", articleUrl: "https://x.com/a/article/123" }).articleUrl, "https://x.com/a/article/123");
});

test("quoted text and its expand button do not affect the main post", () => {
  const quote = { innerText: "引用内容", closest: () => ({}) };
  const main = { innerText: "主帖内容", closest: () => null };
  assert.equal(context.extractTweetText({ querySelectorAll: () => [quote, main] }), "主帖内容");
  assert.equal(context.hasCollapsedText({ querySelectorAll: () => [quote] }), false);
  assert.equal(context.hasCollapsedText({ querySelectorAll: () => [main] }), true);
});

test("quote cards without a test id are scoped by the second author", () => {
  const firstAuthor = {};
  const secondAuthor = { compareDocumentPosition: (node) => node.kind === "quote" ? 4 : 2 };
  const post = { querySelectorAll: (selector) => selector.includes("User-Name") ? [firstAuthor, secondAuthor] : [main, quote] };
  const makeNode = (kind, text) => ({ kind, innerText: text, closest: (selector) => selector === 'article[data-testid="tweet"]' ? post : null });
  const main = makeNode("main", "自己的短推");
  const quote = makeNode("quote", "引用".repeat(3000));
  assert.equal(context.extractTweetText(post), "自己的短推");
  assert.equal(context.isInsideQuote(quote), true);
  assert.equal(context.isInsideQuote(main), false);
});

test("an unidentified second status link makes main-text ownership uncertain", () => {
  const main = { href: "https://x.com/a/status/123", closest: () => null };
  const other = { href: "https://x.com/b/status/456", closest: () => null };
  assert.equal(context.hasAmbiguousReference({ querySelectorAll: () => [main, other] }, "123"), true);
});

test("unresolved main cards are not assumed to be short posts", () => {
  const quote = { closest: () => ({}) };
  const main = { closest: () => null };
  assert.equal(context.hasUnresolvedCard({ querySelectorAll: () => [quote] }), false);
  assert.equal(context.hasUnresolvedCard({ querySelectorAll: () => [main] }), true);
});

test("unknown classification survives normalization and old short guesses are not treated as certain", () => {
  const normalized = normalizeTweet({ id: "1", postType: "unknown", classificationVersion: 2, textLength: 120 });
  assert.equal(normalized.classificationVersion, 2);
  assert.equal(getBookmarkPostType(normalized), "unknown");
  assert.equal(getBookmarkPostType({ postType: "short", textLength: 120 }), "unknown");
  assert.equal(getBookmarkPostType({ isArticle: true }), "unknown");
  assert.equal(isRecognizedArticle({ isArticle: true }), false);
  assert.equal(isRecognizedArticle({ isArticle: true, classificationVersion: 2 }), false);
  assert.equal(isRecognizedArticle({ isArticle: true, classificationVersion: 4 }), true);
  assert.equal(getBookmarkPostType({ textLength: 4000 }), "unknown");
  assert.equal(getBookmarkPostType({ textLength: 4000, classificationVersion: 2 }), "unknown");
  assert.equal(getBookmarkPostType({ postType: "short", classificationVersion: 4 }), "short");
  assert.equal(getBookmarkPostType({ postType: "long", isArticle: true, classificationVerified: true, classificationVersion: 3, textLength: 5000 }), "unknown");
});

test("verified article length enables the long filter and survives index refresh", () => {
  const verified = normalizeTweet({ id: "5", isArticle: true, textLength: 3201, postType: "long", classificationVersion: 4, classificationVerified: true });
  assert.equal(verified.classificationVerified, true);
  assert.equal(getBookmarkPostType(verified), "long");
  assert.equal(getBookmarkPostType({ ...verified, textLength: 3000 }), "unknown");
  const updated = mergeIndexedRecord(verified, normalizeTweet({ id: "5", postType: "unknown", classificationVersion: 2, isArticle: true, textLength: 30 }));
  assert.equal(updated.textLength, 3201);
  assert.equal(updated.classificationVerified, true);
  assert.equal(getBookmarkPostType(updated), "long");
});
