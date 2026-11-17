import test from "node:test";
import assert from "node:assert/strict";
import { mergeIndexedRecord } from "../src/core.js";
import { endedSuspiciouslyEarly, hasCompletedFullSync } from "../src/sync-core.js";
import { isFollowerCountText, needsTitleBackfill } from "../src/core.js";
import { compareSortIndex, describeSyncProgress, isProgressStale, mergeApiRecord, resolveSyncMode, shouldAutoSyncOnOpen, toApiRecord } from "../src/sync-core.js";

const apiTweet = (overrides = {}) => ({
  id: "1", url: "https://x.com/alice/status/1", author: "alice", authorName: "Alice", title: "完整标题", postType: "short",
  classificationVersion: 4, classificationVerified: true, isArticle: false, textLength: 12, hasVideo: false,
  imageUrls: ["https://pbs.twimg.com/media/API?format=jpg&name=large"], coverRatio: 1.5, externalUrls: [], views: "500",
  createdAt: "2024-01-01T00:00:00.000Z", bookmarkSortIndex: "900", dataSource: "api", ...overrides,
});

test("api records keep ordering and source fields but never a post body", () => {
  const record = toApiRecord({ ...apiTweet(), text: "should not be stored" });
  assert.equal(record.text, "");
  assert.equal(record.bookmarkSortIndex, "900");
  assert.equal(record.dataSource, "api");
  assert.equal(record.authorName, "Alice");
  assert.equal(record.coverRatio, 1.5);
  assert.equal(record.contentStatus, "url_only");
});

test("merging api data upgrades old records and preserves user-owned fields", () => {
  const existing = {
    id: "1", title: "截断的标…", author: "alice", imageUrls: ["https://pbs.twimg.com/media/OLD?format=jpg&name=large"], externalUrls: ["https://a.example/"],
    syncedAt: "2023-05-05T00:00:00.000Z", category: "设计", note: "我的备注", projectIds: ["p1"], file: "note.md", hasVideo: true, classificationVersion: 0,
  };
  const merged = mergeApiRecord(existing, toApiRecord(apiTweet({ externalUrls: ["https://b.example/"] })));
  assert.equal(merged.title, "完整标题");
  assert.deepEqual(merged.imageUrls, ["https://pbs.twimg.com/media/API?format=jpg&name=large", "https://pbs.twimg.com/media/OLD?format=jpg&name=large"]);
  assert.deepEqual(merged.externalUrls, ["https://a.example/", "https://b.example/"]);
  assert.deepEqual({ syncedAt: merged.syncedAt, category: merged.category, note: merged.note, projectIds: merged.projectIds, file: merged.file, hasVideo: merged.hasVideo },
    { syncedAt: "2023-05-05T00:00:00.000Z", category: "设计", note: "我的备注", projectIds: ["p1"], file: "note.md", hasVideo: true });
  assert.equal(merged.classificationVerified, true);
  assert.equal(existing.title, "截断的标…");
});

test("a verified article length survives a later timeline refresh", () => {
  const existing = { id: "1", isArticle: true, classificationVerified: true, classificationVersion: 4, textLength: 5200, postType: "long" };
  const merged = mergeApiRecord(existing, toApiRecord(apiTweet({ isArticle: true, classificationVerified: false, postType: "unknown", textLength: 0 })));
  assert.deepEqual({ verified: merged.classificationVerified, length: merged.textLength, type: merged.postType }, { verified: true, length: 5200, type: "long" });
});

test("a placeholder or unknown author from the api does not replace better stored values", () => {
  const merged = mergeApiRecord({ id: "1", title: "已有标题", author: "alice", url: "https://x.com/alice/status/1" }, toApiRecord(apiTweet({ title: "", author: "unknown", url: "https://x.com/i/status/1" })));
  assert.deepEqual({ title: merged.title, author: merged.author, url: merged.url }, { title: "已有标题", author: "alice", url: "https://x.com/alice/status/1" });
});

test("page-scraped data cannot downgrade a record that came from timeline data", () => {
  const stored = mergeApiRecord(null, toApiRecord(apiTweet()));
  const scraped = { id: "1", title: "页面上被截断", postType: "unknown", classificationVerified: false, imageUrls: ["https://pbs.twimg.com/media/DOM?format=jpg&name=large"], hasVideo: true };
  const merged = mergeIndexedRecord(stored, scraped);
  assert.equal(merged.title, "完整标题");
  assert.equal(merged.classificationVerified, true);
  assert.equal(merged.hasVideo, true);
  assert.deepEqual(merged.imageUrls, ["https://pbs.twimg.com/media/API?format=jpg&name=large", "https://pbs.twimg.com/media/DOM?format=jpg&name=large"]);
});

test("sort index compares arbitrarily large integers and keeps missing values last", () => {
  const values = ["99", "", "1000", "100", "1999999999999999999", "1999999999999999998"];
  assert.deepEqual([...values].sort(compareSortIndex), ["1999999999999999999", "1999999999999999998", "1000", "100", "99", ""]);
  assert.equal(compareSortIndex("5", "5"), 0);
});

test("the first run reads everything and later runs only read new bookmarks", () => {
  assert.equal(resolveSyncMode("auto", {}), "full");
  assert.equal(resolveSyncMode("incremental", {}), "full");
  assert.equal(resolveSyncMode("auto", { fullSyncCompletedAt: "2026-01-01T00:00:00Z", engineVersion: 2 }), "incremental");
  assert.equal(resolveSyncMode("full", { fullSyncCompletedAt: "2026-01-01T00:00:00Z", engineVersion: 2 }), "full");
});

test("opening the extension starts a sync unless disabled, running or recently done", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  assert.equal(shouldAutoSyncOnOpen({ now }), true);
  assert.equal(shouldAutoSyncOnOpen({ now, running: true }), false);
  assert.equal(shouldAutoSyncOnOpen({ now, settings: { autoSyncEnabled: false } }), false);
  assert.equal(shouldAutoSyncOnOpen({ now, syncState: { lastAttemptAt: "2026-06-01T11:59:30Z" } }), false);
  assert.equal(shouldAutoSyncOnOpen({ now, syncState: { lastAttemptAt: "2026-06-01T11:00:00Z" } }), true);
  const done = { fullSyncCompletedAt: "2026-05-01T00:00:00Z", engineVersion: 2 };
  assert.equal(shouldAutoSyncOnOpen({ now, syncState: { ...done, lastSyncAt: "2026-06-01T11:50:00Z" } }), false);
  assert.equal(shouldAutoSyncOnOpen({ now, syncState: { ...done, lastSyncAt: "2026-06-01T11:00:00Z" } }), true);
});

test("a running flag without a recent heartbeat is reported as interrupted", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");
  const fresh = { running: true, mode: "full", scanned: 50, message: "已读取 50 条", updatedAt: "2026-06-01T11:59:40Z" };
  assert.equal(isProgressStale(fresh, now), false);
  assert.deepEqual(describeSyncProgress(fresh, { now, knownTotal: 200 }), { active: true, text: "已读取 50 条", percent: 25 });
  assert.equal(describeSyncProgress(fresh, { now }).percent, null);
  const stale = { ...fresh, updatedAt: "2026-06-01T11:50:00Z" };
  assert.equal(isProgressStale(stale, now), true);
  assert.equal(describeSyncProgress(stale, { now }).active, false);
  assert.match(describeSyncProgress(stale, { now }).text, /中断/);
  assert.deepEqual(describeSyncProgress({ running: false, message: "同步完成" }, { now }), { active: false, text: "同步完成", percent: null });
  assert.deepEqual(describeSyncProgress(undefined), { active: false, text: "", percent: null });
});

test("a completion recorded by the earlier engine is not trusted", () => {
  assert.equal(hasCompletedFullSync({ fullSyncCompletedAt: "2026-11-15T14:36:23Z" }), false);
  assert.equal(hasCompletedFullSync({ fullSyncCompletedAt: "2026-11-15T14:36:23Z", engineVersion: 2 }), true);
  assert.equal(resolveSyncMode("auto", { fullSyncCompletedAt: "2026-11-15T14:36:23Z" }), "full");
  assert.equal(shouldAutoSyncOnOpen({ now: Date.parse("2026-11-16T00:00:00Z"), syncState: { fullSyncCompletedAt: "2026-11-15T14:36:23Z", lastSyncAt: "2026-11-15T23:59:00Z", lastAttemptAt: "2026-11-15T14:36:13Z" } }), true);
});

test("only stalled paging is treated as incomplete; a short real list is accepted", () => {
  assert.equal(endedSuspiciouslyEarly({ outcome: "stalled", scanned: 500 }), true);
  assert.equal(endedSuspiciouslyEarly({ outcome: "completed", scanned: 36 }), false);
  assert.equal(endedSuspiciouslyEarly({ outcome: "caught_up", scanned: 20 }), false);
});

test("records whose stored title is a placeholder or a follower count need a title", () => {
  for (const title of ["", "1876 粉丝", "X书签-123", "X 书签", "https://x.com/a/status/1"]) assert.equal(needsTitleBackfill({ id: "1", title }), true, title);
  assert.equal(needsTitleBackfill({ id: "1", title: "真正的标题" }), false);
});

test("follower counts are recognised and never kept as a title", () => {
  for (const text of ["1876 粉丝", "1.2万 粉丝", "5,929 位关注者", "12.3K Followers", "1 follower"]) assert.equal(isFollowerCountText(text), true, text);
  for (const text of ["两千粉的视频号，怎么赚钱", "粉丝", "How I got 10K followers in a month"]) assert.equal(isFollowerCountText(text), false, text);
  const merged = mergeIndexedRecord({ id: "1", title: "真正的标题" }, { id: "1", title: "1876 粉丝" });
  assert.equal(merged.title, "真正的标题");
});

import { isRepositionedRecord } from "../src/sync-core.js";

test("re-bookmarked and never-upgraded records are recognised, unchanged ones are not", () => {
  assert.equal(isRepositionedRecord(undefined, { bookmarkSortIndex: "9" }), false);
  assert.equal(isRepositionedRecord({ id: "1", title: "1876 粉丝" }, { bookmarkSortIndex: "9" }), true);
  assert.equal(isRepositionedRecord({ id: "1", dataSource: "api", bookmarkSortIndex: "5" }, { bookmarkSortIndex: "9" }), true);
  assert.equal(isRepositionedRecord({ id: "1", dataSource: "api", bookmarkSortIndex: "9" }, { bookmarkSortIndex: "9" }), false);
});

test("re-bookmarking updates the same record instead of creating a second one", () => {
  const old = { id: "77", title: "1876 粉丝", author: "someone", url: "https://x.com/someone/status/77", note: "我的备注", syncedAt: "2026-01-01T00:00:00.000Z", imageUrls: [] };
  const merged = mergeApiRecord(old, toApiRecord(apiTweet({ id: "77", url: "https://x.com/someone/status/77", author: "someone", title: "文章的真实标题", bookmarkSortIndex: "999" })));
  assert.deepEqual({ id: merged.id, title: merged.title, note: merged.note, syncedAt: merged.syncedAt, order: merged.bookmarkSortIndex }, { id: "77", title: "文章的真实标题", note: "我的备注", syncedAt: "2026-01-01T00:00:00.000Z", order: "999" });
});
