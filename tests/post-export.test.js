import test from "node:test";
import assert from "node:assert/strict";
import { buildPostFilename, buildPostMarkdown } from "../src/post-export.js";
import { displayTitle, mergeIndexedRecord, needsTitleBackfill } from "../src/core.js";
import { mergeApiRecord } from "../src/sync-core.js";

const record = { id: "42", title: "一篇文章", author: "alice", authorName: "Alice", url: "https://x.com/alice/status/42", createdAt: "2026-01-02T03:04:05.000Z", imageUrls: ["https://pbs.twimg.com/media/A?format=jpg&name=large"], note: "值得再看" };
const exportedAt = new Date("2026-11-15T00:00:00.000Z");

test("markdown export has frontmatter, heading, source line, body and the user's note", () => {
  const markdown = buildPostMarkdown(record, { body: "## 小标题\n\n正文第一段。", exportedAt });
  assert.equal(markdown, [
    "---", 'title: "一篇文章"', 'author: "@alice"', 'author_name: "Alice"', 'url: "https://x.com/alice/status/42"', 'published: "2026-01-02T03:04:05.000Z"', 'saved: "2026-11-15T00:00:00.000Z"', 'tweet_id: "42"', "---", "",
    "# 一篇文章", "", "> 原文：https://x.com/alice/status/42　作者：@alice", "", "## 小标题", "", "正文第一段。", "", "## 备注", "", "值得再看", "",
  ].join("\n"));
});

test("export without a readable body falls back to stored information and says so", () => {
  const markdown = buildPostMarkdown({ ...record, note: "" }, { exportedAt });
  assert.match(markdown, /!\[\]\(https:\/\/pbs\.twimg\.com\/media\/A/);
  assert.match(markdown, /未能读取正文/);
  assert.doesNotMatch(markdown, /## 备注/);
  assert.match(buildPostMarkdown({ id: "1", author: "bob", title: 'say "hi"\nnow' }, { title: "页面上的标题", exportedAt }), /^---\ntitle: "页面上的标题"/);
});

test("filenames are safe, bounded and unique per post", () => {
  assert.equal(buildPostFilename(record), "一篇文章-42.md");
  assert.equal(buildPostFilename({ id: "7", title: 'a/b:c*?"<>| #tag [x]' }), "a b c tag x-7.md");
  assert.equal(buildPostFilename({ id: "9", title: "" }), "x-bookmark-9.md");
  assert.equal(buildPostFilename({ id: "8", title: "长".repeat(100) }), `${"长".repeat(60)}-8.md`);
  assert.equal(buildPostFilename({ id: "../etc", title: "..hidden" }), "hidden-etc.md");
});

test("an edited title survives later syncs and page scrapes", () => {
  const edited = { id: "42", title: "我改的标题", titleEdited: true, dataSource: "api", bookmarkSortIndex: "5" };
  assert.equal(mergeApiRecord(edited, { id: "42", title: "X 上的标题", bookmarkSortIndex: "5" }).title, "我改的标题");
  assert.equal(mergeIndexedRecord({ id: "42", title: "我改的标题", titleEdited: true }, { id: "42", title: "页面标题" }).title, "我改的标题");
});

test("a deleted post stays hidden through syncs and returns only when bookmarked again", () => {
  const hidden = { id: "42", title: "t", hidden: true, dataSource: "api", bookmarkSortIndex: "5" };
  assert.equal(mergeApiRecord(hidden, { id: "42", title: "t", bookmarkSortIndex: "5" }).hidden, true);
  assert.equal(mergeApiRecord(hidden, { id: "42", title: "t", bookmarkSortIndex: "9" }).hidden, false);
  assert.equal(mergeApiRecord({ id: "42", hidden: true }, { id: "42", title: "t", bookmarkSortIndex: "9" }).hidden, true);
  assert.equal(mergeIndexedRecord({ id: "42", title: "t", hidden: true }, { id: "42", title: "t2" }).hidden, true);
});

test("media-only posts are final, not missing a title, and get a readable stand-in", () => {
  assert.equal(needsTitleBackfill({ id: "1", title: "", untitled: true }), false);
  assert.equal(needsTitleBackfill({ id: "1", title: "", hidden: true }), false);
  assert.equal(needsTitleBackfill({ id: "1", title: "" }), true);
  assert.equal(displayTitle({ author: "bob", title: "", untitled: true, imageUrls: ["a"] }), "@bob 的图片（无文字）");
  assert.equal(displayTitle({ author: "bob", title: "1876 粉丝", isArticle: true }), "@bob 的文章（暂无标题）");
  assert.equal(displayTitle({ author: "bob", title: "真标题" }), "真标题");
  assert.equal(mergeApiRecord({ id: "1", untitled: true }, { id: "1", title: "现在有标题了", bookmarkSortIndex: "1" }).untitled, false);
});
