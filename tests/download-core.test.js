import test from "node:test";
import assert from "node:assert/strict";
import { filterBookmarkRecords } from "../src/manager-core.js";
import { mergeApiRecord } from "../src/sync-core.js";
import { frontmatterTweetId, authorFolderName, buildDownloadMark, buildDownloadPath, clearedDownloadMark, copyFilename, describeDownloadMark, formatSavedLocation, isDownloaded, normalizeDownloadPrefs, resolveDownloadTarget, resolveDuplicateAction } from "../src/download-core.js";

test("download preferences default to asking once and ignore unknown values", () => {
  assert.deepEqual(normalizeDownloadPrefs(undefined), { mode: "ask", byAuthor: false, duplicate: "ask", saveMedia: true });
  assert.deepEqual(normalizeDownloadPrefs({ mode: "folder", byAuthor: true }), { mode: "folder", byAuthor: true, duplicate: "ask", saveMedia: true });
  assert.deepEqual(normalizeDownloadPrefs({ mode: "cloud", byAuthor: "yes" }), { mode: "ask", byAuthor: false, duplicate: "ask", saveMedia: true });
  assert.deepEqual(normalizeDownloadPrefs("browser"), { mode: "ask", byAuthor: false, duplicate: "ask", saveMedia: true });
});

test("the target asks first, then follows the saved choice, and falls back when folders are unavailable", () => {
  assert.equal(resolveDownloadTarget({ prefs: { mode: "ask" }, hasFolder: false, canPick: true }), "ask");
  assert.equal(resolveDownloadTarget({ prefs: { mode: "folder" }, hasFolder: true, canPick: true }), "folder");
  // The saved folder was forgotten or could not be loaded: ask again instead of failing.
  assert.equal(resolveDownloadTarget({ prefs: { mode: "folder" }, hasFolder: false, canPick: true }), "ask");
  assert.equal(resolveDownloadTarget({ prefs: { mode: "browser" }, hasFolder: true, canPick: true }), "browser");
  assert.equal(resolveDownloadTarget({ prefs: { mode: "ask" }, hasFolder: false, canPick: false }), "browser");
  assert.equal(resolveDownloadTarget({ prefs: { mode: "folder" }, hasFolder: true, canPick: false }), "browser");
});

test("author folders are safe names and fall back for missing authors", () => {
  assert.equal(authorFolderName("alice"), "alice");
  assert.equal(authorFolderName("@bob_1"), "bob_1");
  assert.equal(authorFolderName("../evil:name"), "evil name");
  assert.equal(authorFolderName(""), "unknown");
  assert.equal(authorFolderName(undefined), "unknown");
  assert.equal(authorFolderName(".."), "unknown");
});

test("download paths add an author folder only when asked", () => {
  const record = { id: "1", author: "alice" };
  assert.equal(buildDownloadPath(record, "标题-1.md", { byAuthor: false }), "标题-1.md");
  assert.equal(buildDownloadPath(record, "标题-1.md", { byAuthor: true }), "alice/标题-1.md");
  assert.equal(buildDownloadPath({ id: "2" }, "x-2.md", { byAuthor: true }), "unknown/x-2.md");
  assert.equal(buildDownloadPath(record, "x-1.md"), "x-1.md");
});

test("saved locations read as folder / path", () => {
  assert.equal(formatSavedLocation("Obsidian", "alice/标题-1.md"), "Obsidian / alice / 标题-1.md");
  assert.equal(formatSavedLocation("", "a.md"), "a.md");
});

test("duplicate handling defaults to asking and keeps a remembered choice", () => {
  assert.equal(normalizeDownloadPrefs({}).duplicate, "ask");
  assert.equal(normalizeDownloadPrefs({ duplicate: "overwrite" }).duplicate, "overwrite");
  assert.equal(normalizeDownloadPrefs({ duplicate: "copy" }).duplicate, "copy");
  assert.equal(normalizeDownloadPrefs({ duplicate: "delete" }).duplicate, "ask");
  assert.equal(normalizeDownloadPrefs({ saveMedia: false }).saveMedia, false);
  assert.equal(normalizeDownloadPrefs({ saveMedia: "no" }).saveMedia, true);
});

test("a post that was never downloaded is saved without asking", () => {
  const prefs = normalizeDownloadPrefs({});
  assert.equal(resolveDuplicateAction({ prefs, record: {}, target: "folder", fileExists: false }), "save");
  // A file left by an older version of the extension is the same post, so it is updated in place.
  assert.equal(resolveDuplicateAction({ prefs, record: {}, target: "folder", fileExists: true }), "save");
});

test("a downloaded post asks again unless the user chose to remember", () => {
  const record = { downloadedAt: "2026-11-18T10:00:00.000Z" };
  const ask = normalizeDownloadPrefs({});
  assert.equal(resolveDuplicateAction({ prefs: ask, record, target: "folder", fileExists: true }), "ask");
  assert.equal(resolveDuplicateAction({ prefs: ask, record, target: "folder", fileExists: false }), "ask");
  assert.equal(resolveDuplicateAction({ prefs: ask, record, target: "browser", fileExists: false }), "ask");
  const overwrite = normalizeDownloadPrefs({ duplicate: "overwrite" });
  assert.equal(resolveDuplicateAction({ prefs: overwrite, record, target: "folder", fileExists: true }), "overwrite");
  assert.equal(resolveDuplicateAction({ prefs: overwrite, record, target: "folder", fileExists: false }), "save");
  const copy = normalizeDownloadPrefs({ duplicate: "copy" });
  assert.equal(resolveDuplicateAction({ prefs: copy, record, target: "folder", fileExists: true }), "copy");
  // The browser renames repeated downloads by itself, so a remembered choice simply downloads again.
  assert.equal(resolveDuplicateAction({ prefs: copy, record, target: "browser", fileExists: false }), "save");
});

test("copies get the first free numbered name", () => {
  const taken = new Set(["标题-1.md", "标题-1 (2).md"]);
  assert.equal(copyFilename("标题-1.md", (name) => taken.has(name)), "标题-1 (3).md");
  assert.equal(copyFilename("a.md", () => false), "a (2).md");
  assert.equal(copyFilename("noext", () => false), "noext (2)");
});

test("download marks record when, where and how a post was saved", () => {
  const at = new Date("2026-11-18T10:00:00.000Z");
  assert.deepEqual(buildDownloadMark({ at, target: "folder", folderName: "Vault", path: "alice/a-1.md" }), {
    downloadedAt: "2026-11-18T10:00:00.000Z",
    download: { target: "folder", folder: "Vault", path: "alice/a-1.md" },
  });
  assert.deepEqual(buildDownloadMark({ at, target: "browser", folderName: "", path: "a-1.md" }).download, { target: "browser", folder: "", path: "a-1.md" });
  assert.deepEqual(clearedDownloadMark(), { downloadedAt: "", download: null });
});

test("download marks are described for cards and dialogs", () => {
  assert.equal(isDownloaded({}), false);
  assert.equal(isDownloaded({ downloadedAt: "2026-11-18T10:00:00.000Z" }), true);
  assert.equal(describeDownloadMark({ downloadedAt: "2026-11-18T10:00:00.000Z", download: { target: "folder", folder: "Vault", path: "alice/a.md" } }).location, "Vault / alice / a.md");
  assert.equal(describeDownloadMark({ downloadedAt: "2026-11-18T10:00:00.000Z", download: { target: "browser", folder: "", path: "a.md" } }).location, "浏览器下载 · a.md");
  assert.equal(describeDownloadMark({ downloadedAt: "2026-11-18T10:00:00.000Z" }).location, "");
  assert.match(describeDownloadMark({ downloadedAt: "2026-11-18T10:00:00.000Z" }).when, /2026/);
});

test("the downloaded filter keeps or drops marked posts", () => {
  const records = [{ id: "1", downloadedAt: "2026-11-18T10:00:00.000Z" }, { id: "2" }];
  assert.deepEqual(filterBookmarkRecords(records, { downloaded: "yes" }).map((r) => r.id), ["1"]);
  assert.deepEqual(filterBookmarkRecords(records, { downloaded: "no" }).map((r) => r.id), ["2"]);
  assert.equal(filterBookmarkRecords(records, { downloaded: "" }).length, 2);
});

test("syncing a post from X keeps its download mark", () => {
  const existing = { id: "9", title: "a", author: "bob", downloadedAt: "2026-11-18T10:00:00.000Z", download: { target: "folder", folder: "Vault", path: "a-9.md" } };
  const merged = mergeApiRecord(existing, { id: "9", title: "a", author: "bob", downloadedAt: "" });
  assert.equal(merged.downloadedAt, existing.downloadedAt);
  assert.deepEqual(merged.download, existing.download);
});

test("the post id is read back from a saved note to tell same-named posts apart", () => {
  assert.equal(frontmatterTweetId('---\ntitle: "a"\ntweet_id: "42"\n---\n\n# a'), "42");
  assert.equal(frontmatterTweetId("---\ntweet_id: 42\n---"), "42");
  assert.equal(frontmatterTweetId("# a note without properties\ntweet_id: \"42\""), "");
  assert.equal(frontmatterTweetId(""), "");
});
