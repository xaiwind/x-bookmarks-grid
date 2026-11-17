import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIndexMarkdown,
  buildUrlOnlyMarkdown,
  buildTweetMarkdown,
  createSafeTweetFilename,
  extractTweetId,
  findNewTweets,
  normalizeTweet,
  selectCategory,
  shouldIncludePostType,
  mergeIndexedRecord,
} from "../src/core.js";

test("extractTweetId handles x.com and twitter.com status URLs with query strings", () => {
  assert.equal(
    extractTweetId("https://x.com/someone/status/1234567890?s=20"),
    "1234567890",
  );
  assert.equal(
    extractTweetId("https://twitter.com/someone/status/9876543210/photo/1"),
    "9876543210",
  );
});

test("findNewTweets skips tweets already present in seen map", () => {
  const tweets = [
    { id: "1", url: "https://x.com/a/status/1" },
    { id: "2", url: "https://x.com/b/status/2" },
  ];
  const seen = { 1: { sync_status: "indexed" } };

  assert.deepEqual(findNewTweets(tweets, seen).map((tweet) => tweet.id), ["2"]);
});

test("normalizeTweet extracts id from URL and defaults category and statuses", () => {
  const tweet = normalizeTweet({
    url: "https://x.com/codex/status/42",
    author: "codex",
    text: "hello world",
  }, "AI");

  assert.equal(tweet.id, "42");
  assert.equal(tweet.category, "AI");
  assert.equal(tweet.syncStatus, "indexed");
  assert.equal(tweet.articleStatus, "link_only");
});

test("normalizeTweet does not use URL as title fallback", () => {
  const tweet = normalizeTweet({
    id: "42",
    url: "https://x.com/codex/status/42",
    author: "codex",
  }, "AI");

  assert.equal(tweet.title, "X书签-42");
});

test("shouldIncludePostType supports all, long, and short filters", () => {
  assert.equal(shouldIncludePostType({ postType: "long" }, "all"), true);
  assert.equal(shouldIncludePostType({ postType: "long" }, "long"), true);
  assert.equal(shouldIncludePostType({ postType: "short" }, "long"), false);
  assert.equal(shouldIncludePostType({ postType: "short" }, "short"), true);
});

test("normalizeTweet keeps detected post type for later filtering and search", () => {
  const tweet = normalizeTweet({
    id: "42",
    url: "https://x.com/codex/status/42",
    title: "Long form note",
    postType: "long",
  }, "AI");

  assert.equal(tweet.postType, "long");
});

test("selectCategory supports X folder and custom category modes", () => {
  const tweet = { bookmarkFolder: "AI 精读" };

  assert.equal(selectCategory(tweet, {
    categoryMode: "x_folder",
    fallbackCategory: "未分类",
  }), "AI 精读");

  assert.equal(selectCategory(tweet, {
    categoryMode: "custom",
    customCategory: "商业洞察",
    fallbackCategory: "未分类",
  }), "商业洞察");
});

test("selectCategory falls back to uncategorized when X folder is empty", () => {
  assert.equal(selectCategory({}, {
    categoryMode: "x_folder",
    selectedCategory: "AI",
    fallbackCategory: "未分类",
  }), "未分类");
});

test("createSafeTweetFilename includes date, id, and normalized author", () => {
  assert.equal(
    createSafeTweetFilename({
      id: "123",
      author: "@hello/world",
      title: "How to build a calm sync tool",
      syncedAt: "2026-06-28T12:00:00.000Z",
    }),
    "How-to-build-a-calm-sync-tool-123.md",
  );
});

test("buildTweetMarkdown includes frontmatter, remote images, and external links", () => {
  const markdown = buildTweetMarkdown({
    id: "123",
    url: "https://x.com/user/status/123",
    author: "user",
    title: "A useful post",
    text: "A useful post",
    views: "1.2万",
    category: "自媒体",
    imageUrls: ["https://pbs.twimg.com/media/a.jpg"],
    externalUrls: ["https://example.com/article"],
    syncedAt: "2026-06-28T12:00:00.000Z",
    syncStatus: "indexed",
    articleStatus: "link_only",
  });

  assert.match(markdown, /tweet_id: "123"/);
  assert.match(markdown, /title: "A useful post"/);
  assert.match(markdown, /category: "自媒体"/);
  assert.match(markdown, /浏览量：1.2万/);
  assert.match(markdown, /^# A useful post/m);
  assert.match(markdown, /## 正文\n\nA useful post/);
  assert.match(markdown, /!\[\]\(https:\/\/pbs\.twimg\.com\/media\/a\.jpg\)/);
  assert.match(markdown, /- https:\/\/example\.com\/article/);
});

test("buildUrlOnlyMarkdown records original URL without requiring tweet content", () => {
  const markdown = buildUrlOnlyMarkdown({
    id: "123",
    url: "https://x.com/user/status/123",
    author: "user",
    title: "Great thread about AI agents",
    views: "23K",
    category: "AI",
    syncedAt: "2026-06-28T12:00:00.000Z",
  });

  assert.match(markdown, /content_status: url_only/);
  assert.match(markdown, /title: "Great thread about AI agents"/);
  assert.match(markdown, /article_status: link_only/);
  assert.match(markdown, /^# Great thread about AI agents/m);
  assert.match(markdown, /浏览量：23K/);
  assert.match(markdown, /原文链接：https:\/\/x\.com\/user\/status\/123/);
  assert.match(markdown, /## 后续内容同步/);
});

test("buildIndexMarkdown groups records by category with status markers", () => {
  const markdown = buildIndexMarkdown([
    {
      id: "1",
      author: "alice",
      category: "AI",
      file: "推特同步/AI/Long-text-that-becomes-the-summary-1.md",
      title: "Long text that becomes the summary",
      text: "Long text that becomes the summary",
      syncStatus: "indexed",
      articleStatus: "downloaded",
      contentStatus: "content_synced",
    },
    {
      id: "2",
      author: "bob",
      category: "出海",
      file: "01 资料仓库/推特收藏/出海/2026-06-28-2-bob.md",
      text: "Another note",
      syncStatus: "failed",
      articleStatus: "link_only",
      contentStatus: "url_only",
    },
  ]);

  assert.match(markdown, /## AI/);
  assert.match(markdown, /\[INDEXED\] \[CONTENT_SYNCED\] \[ARTICLE_DOWNLOADED\] \[\[Long-text-that-becomes-the-summary-1\]\]/);
  assert.match(markdown, /## 出海/);
  assert.match(markdown, /\[FAILED\] \[URL_ONLY\] \[LINK_ONLY\] \[\[2026-06-28-2-bob\]\]/);
});

test("mergeIndexedRecord refreshes title and category without downgrading content status", () => {
  const merged = mergeIndexedRecord({
    id: "42",
    title: "https://x.com/codex/status/42",
    category: "旧分类",
    file: "推特同步/旧分类/X书签-42.md",
    contentStatus: "content_synced",
    articleStatus: "link_only",
    text: "old body",
    imageUrls: ["https://pbs.twimg.com/media/old"],
  }, {
    id: "42",
    title: "新的文字标题",
    category: "自定义分类",
    file: "推特同步/自定义分类/新的文字标题-42.md",
    contentStatus: "url_only",
    articleStatus: "link_only",
    imageUrls: ["https://pbs.twimg.com/media/new"],
  });

  assert.equal(merged.title, "新的文字标题");
  assert.equal(merged.category, "自定义分类");
  assert.equal(merged.file, "推特同步/旧分类/X书签-42.md");
  assert.equal(merged.contentStatus, "content_synced");
  assert.equal(merged.text, "old body");
  assert.deepEqual(merged.imageUrls, ["https://pbs.twimg.com/media/new", "https://pbs.twimg.com/media/old"]);
});
