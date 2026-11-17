import test from "node:test";
import assert from "node:assert/strict";

import {
  collectCategoryOptions,
  recordDisplayTitle,
  sortBookmarkRecords,
  summarizeBookmarkCounts,
  describeBookmarkCounts,
  bookmarkSourceDisplay,
} from "../src/manager-core.js";

test("recordDisplayTitle does not show a raw URL as the manager title", () => {
  assert.equal(recordDisplayTitle({
    id: "42",
    title: "https://x.com/codex/status/42",
    file: "推特同步/未分类/Useful-AI-note-42.md",
  }), "X书签-42");
});

test("collection totals distinguish X-reported counts from local and scanned counts", () => {
  assert.deepEqual(summarizeBookmarkCounts([{ id: "1" }, { id: "2" }], { scannedCount: 4 }), { sourceTotal: null, syncedTotal: 2, scannedCount: 4 });
  assert.deepEqual(summarizeBookmarkCounts([], { xTotal: 0, scannedCount: 0 }), { sourceTotal: 0, syncedTotal: 0, scannedCount: 0 });
  assert.deepEqual(summarizeBookmarkCounts([], { xTotal: -1, scannedCount: "20" }), { sourceTotal: null, syncedTotal: 0, scannedCount: null });
});

test("count guidance explains unknown totals and identifies a reported gap", () => {
  assert.match(describeBookmarkCounts({ sourceTotal: null, syncedTotal: 2, scannedCount: 10 }), /暂未获取 X 收藏总数/);
  assert.match(describeBookmarkCounts({ sourceTotal: 20, syncedTotal: 2, scannedCount: 10 }), /可继续同步/);
  assert.match(describeBookmarkCounts({ sourceTotal: 2, syncedTotal: 3, scannedCount: null }), /本地/);
});

test("X count shows a lower bound when only a scan count is available", () => {
  assert.deepEqual(bookmarkSourceDisplay({ sourceTotal: null, scannedCount: 12 }), { label: "X 收藏（已扫描）", value: "≥12" });
  assert.deepEqual(bookmarkSourceDisplay({ sourceTotal: 20, scannedCount: 12 }), { label: "X 收藏总数", value: "20" });
  assert.deepEqual(bookmarkSourceDisplay({ sourceTotal: null, scannedCount: 0 }), { label: "X 收藏总数", value: "未获取" });
});

test("sorts by publish time or views and keeps missing dates last", () => {
  const entries = [
    { id: "missing", views: "1万" },
    { id: "old", createdAt: "2020-01-01T00:00:00Z", views: "2M" },
    { id: "new", createdAt: "2024-01-01T00:00:00Z", views: "3K" },
  ];
  assert.deepEqual(sortBookmarkRecords(entries, "newest").map((r) => r.id), ["new", "old", "missing"]);
  assert.deepEqual(sortBookmarkRecords(entries, "oldest").map((r) => r.id), ["old", "new", "missing"]);
  assert.deepEqual(sortBookmarkRecords(entries, "views").map((r) => r.id), ["old", "missing", "new"]);
  assert.equal(entries[0].id, "missing");
});

test("recordDisplayTitle prefers real text titles", () => {
  assert.equal(recordDisplayTitle({
    id: "43",
    title: "一条值得保存的长文",
    file: "推特同步/未分类/backup-43.md",
  }), "一条值得保存的长文");
});

test("recordDisplayTitle never derives fake titles from file paths", () => {
  assert.equal(recordDisplayTitle({
    id: "99",
    title: "",
    text: "",
    file: "推特同步/未分类/author-status-id-99.md",
  }), "X书签-99");
});

test("collectCategoryOptions only uses categories present in synced records", () => {
  assert.deepEqual(collectCategoryOptions([
    { category: "自定义分类" },
    { category: "X 书签分类" },
    { category: "自定义分类" },
    { category: "" },
  ]), ["自定义分类", "X 书签分类"]);
});

import { bookmarkCategory, columnCountForWidth, countBookmarkTypes, filterBookmarkRecords, formatCompactCount, listTopAuthors, matchesBookmarkType } from "../src/manager-core.js";

const library = [
  { id: "1", title: "Rust 异步入门", author: "alice", authorName: "Alice Chen", url: "https://x.com/alice/status/1", createdAt: "2024-03-10T12:00:00", views: "2500000", classificationVersion: 4, postType: "short", imageUrls: ["a"], externalUrls: ["https://docs.rs/tokio"], bookmarkSortIndex: "300" },
  { id: "2", title: "设计系统长文", author: "bob", url: "https://x.com/bob/status/2", createdAt: "2024-05-01T12:00:00", views: "900", classificationVersion: 4, classificationVerified: true, textLength: 5000, postType: "long", bookmarkSortIndex: "1200" },
  { id: "3", title: "一篇 X 文章", author: "alice", url: "https://x.com/alice/status/3", createdAt: "2025-01-02T12:00:00", classificationVersion: 4, isArticle: true, imageUrls: ["c"], hasVideo: false, bookmarkSortIndex: "250" },
  { id: "4", title: "演示视频", author: "carol", url: "https://x.com/carol/status/4", syncedAt: "2025-02-02T12:00:00", hasVideo: true, imageUrls: ["d"] },
];
const ids = (records) => records.map((record) => record.id);

test("every record falls into exactly one category and the categories add up to the total", () => {
  const mixed = [
    ...library,
    { id: "5", title: "纯文字想法", author: "dan", classificationVersion: 4, postType: "short" },
    { id: "6", title: "", untitled: true, author: "eve", hasVideo: true, imageUrls: ["e"] },
    { id: "7", title: "1876 粉丝", author: "fay", isArticle: true, classificationVersion: 4 },
    { id: "8", title: "带图又带视频", author: "gus", hasVideo: true, imageUrls: ["g"] },
  ];
  const counts = countBookmarkTypes(mixed);
  assert.deepEqual(counts, { all: 8, article: 1, video: 2, image: 1, text: 2, untitled: 2 });
  assert.equal(counts.article + counts.video + counts.image + counts.text + counts.untitled, counts.all);
  assert.deepEqual(mixed.map(bookmarkCategory), ["image", "text", "article", "video", "text", "untitled", "untitled", "video"]);
  for (const type of ["article", "video", "image", "text", "untitled"]) assert.equal(filterBookmarkRecords(mixed, { type }).length, counts[type], type);
  assert.equal(matchesBookmarkType(library[3], "image"), false);
  assert.deepEqual(ids(filterBookmarkRecords(library, { type: "article" })), ["3"]);
});

test("a minimum view count narrows any category without changing the categories", () => {
  assert.deepEqual(ids(filterBookmarkRecords(library, { minViews: 1_000_000 })), ["1"]);
  assert.deepEqual(ids(filterBookmarkRecords(library, { minViews: "900" })), ["1", "2"]);
  assert.deepEqual(ids(filterBookmarkRecords(library, { minViews: 1_000_000, type: "article" })), []);
  assert.deepEqual(ids(filterBookmarkRecords(library, { minViews: "" })), ["1", "2", "3", "4"]);
});

test("search matches titles, names, links and @handles and combines with other filters", () => {
  assert.deepEqual(ids(filterBookmarkRecords(library, { query: "rust 异步" })), ["1"]);
  assert.deepEqual(ids(filterBookmarkRecords(library, { query: "tokio" })), ["1"]);
  assert.deepEqual(ids(filterBookmarkRecords(library, { query: "chen" })), ["1"]);
  assert.deepEqual(ids(filterBookmarkRecords(library, { query: "@alice" })), ["1", "3"]);
  assert.deepEqual(ids(filterBookmarkRecords(library, { author: "@ALICE", type: "image" })), ["1"]);
  assert.deepEqual(ids(filterBookmarkRecords(library, { hasLinks: "yes" })), ["1"]);
  assert.deepEqual(ids(filterBookmarkRecords(library, { hasLinks: "no", author: "alice" })), ["3"]);
  assert.deepEqual(ids(filterBookmarkRecords(library, { fromDate: "2024-05-01", toDate: "2025-01-02" })), ["2", "3"]);
  assert.deepEqual(ids(filterBookmarkRecords(library, { fromDate: "2025-02-01" })), ["4"]);
  assert.deepEqual(ids(filterBookmarkRecords([{ id: "x" }], { fromDate: "2020-01-01" })), []);
  assert.deepEqual(ids(filterBookmarkRecords(library)), ["1", "2", "3", "4"]);
});

test("bookmark order follows X's timeline position and falls back to publish time", () => {
  assert.deepEqual(ids(sortBookmarkRecords(library, "bookmarked")), ["2", "1", "3", "4"]);
  const unordered = [{ id: "a", createdAt: "2020-01-01T00:00:00Z" }, { id: "b", createdAt: "2024-01-01T00:00:00Z" }];
  assert.deepEqual(ids(sortBookmarkRecords(unordered, "bookmarked")), ["b", "a"]);
});

test("authors are ranked by bookmark count and unknown authors are skipped", () => {
  assert.deepEqual(listTopAuthors([...library, { author: "unknown" }, { author: "" }], 2), [{ author: "alice", name: "Alice Chen", count: 2 }, { author: "bob", name: "", count: 1 }]);
});

test("view counts are compact and column counts follow the container width", () => {
  assert.deepEqual(["2500000", "12345", "999", "1.2M", "3亿", "", "abc"].map(formatCompactCount), ["250万", "1.2万", "999", "120万", "3亿", "", ""]);
  assert.deepEqual([0, 300, 536, 1100, 5000].map((width) => columnCountForWidth(width)), [1, 1, 2, 4, 6]);
});

import { filterAuthorOptions } from "../src/manager-core.js";

test("the author list shows everyone until text is typed, then narrows by handle", () => {
  const authors = [{ author: "alice", count: 3 }, { author: "Bob_Dev", count: 2 }, { author: "carol", count: 1 }];
  assert.deepEqual(filterAuthorOptions(authors, "").map((item) => item.author), ["alice", "Bob_Dev", "carol"]);
  assert.deepEqual(filterAuthorOptions(authors, " @BOB ").map((item) => item.author), ["Bob_Dev"]);
  assert.deepEqual(filterAuthorOptions(authors, "o").map((item) => item.author), ["Bob_Dev", "carol"]);
  assert.deepEqual(filterAuthorOptions(authors, "", 2).length, 2);
  assert.deepEqual(filterAuthorOptions(authors, "nobody"), []);
});

test("author options carry the nickname, taken from the author's newest post that has one", () => {
  const posts = [
    { author: "alice", authorName: "Old Alice", createdAt: "2026-01-01T00:00:00Z" },
    { author: "alice", authorName: "爱丽丝", createdAt: "2026-03-01T00:00:00Z" },
    { author: "alice", createdAt: "2026-05-01T00:00:00Z" },
    { author: "bob" },
    { author: "carol", authorName: "  " },
  ];
  assert.deepEqual(listTopAuthors(posts), [{ author: "alice", name: "爱丽丝", count: 3 }, { author: "bob", name: "", count: 1 }, { author: "carol", name: "", count: 1 }]);
});

test("typing a nickname finds the author, and options without a nickname still match by handle", () => {
  const options = [{ author: "alice", name: "爱丽丝", count: 3 }, { author: "bob_dev", name: "Bob the Builder", count: 1 }, { author: "carol", count: 1 }];
  assert.deepEqual(filterAuthorOptions(options, "丽").map((item) => item.author), ["alice"]);
  assert.deepEqual(filterAuthorOptions(options, "BUILDER").map((item) => item.author), ["bob_dev"]);
  assert.deepEqual(filterAuthorOptions(options, "@car").map((item) => item.author), ["carol"]);
});
