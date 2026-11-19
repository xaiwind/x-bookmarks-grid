import test from "node:test";
import assert from "node:assert/strict";
import { buildPostFilename, buildPostMarkdown } from "../src/post-export.js";
import { displayTitle, mergeIndexedRecord, needsTitleBackfill } from "../src/core.js";
import { mergeApiRecord } from "../src/sync-core.js";

const record = { id: "42", views: "12345", title: "一篇文章", author: "alice", authorName: "Alice", url: "https://x.com/alice/status/42", createdAt: "2026-01-02T03:04:05.000Z", imageUrls: ["https://pbs.twimg.com/media/A?format=jpg&name=large"], note: "值得再看" };
const exportedAt = new Date("2026-11-15T00:00:00.000Z");

test("markdown export has frontmatter, heading, source line, body and the user's note", () => {
  const markdown = buildPostMarkdown(record, { body: "## 小标题\n\n正文第一段。", exportedAt });
  assert.equal(markdown, [
    "---", 'title: "一篇文章"', 'author: "@alice"', 'author_name: "Alice"', 'url: "https://x.com/alice/status/42"', 'published: "2026-01-02T03:04:05.000Z"', "views: 12345", 'saved: "2026-11-15T00:00:00.000Z"', 'tweet_id: "42"', "---", "",
    "# 一篇文章", "", "> 原文：https://x.com/alice/status/42　作者：@alice", "", "## 小标题", "", "正文第一段。", "", "![](https://pbs.twimg.com/media/A?format=jpg&name=large)", "", "## 备注", "", "值得再看", "",
  ].join("\n"));
});

test("export without a readable body falls back to stored information and says so", () => {
  const markdown = buildPostMarkdown({ ...record, note: "" }, { exportedAt });
  assert.match(markdown, /!\[\]\(https:\/\/pbs\.twimg\.com\/media\/A/);
  assert.match(markdown, /未能读取正文/);
  assert.doesNotMatch(markdown, /## 备注/);
  assert.match(buildPostMarkdown({ id: "1", author: "bob", title: 'say "hi"\nnow' }, { title: "页面上的标题", exportedAt }), /^---\ntitle: "页面上的标题"/);
});

test("filenames are the title alone: safe, bounded, with no post id", () => {
  assert.equal(buildPostFilename(record), "一篇文章.md");
  assert.equal(buildPostFilename({ id: "7", title: 'a/b:c*?"<>| #tag [x]' }), "a b c tag x.md");
  assert.equal(buildPostFilename({ id: "8", title: "长".repeat(100) }), `${"长".repeat(60)}.md`);
  assert.equal(buildPostFilename({ id: "1", title: "..hidden" }), "hidden.md");
  // No title: author and date, never the id.
  assert.equal(buildPostFilename({ id: "9", title: "", author: "bob", createdAt: "2026-01-02T03:04:05.000Z" }), "bob 2026-01-02.md");
  assert.equal(buildPostFilename({ id: "9", title: "" }), "x-bookmark.md");
  assert.doesNotMatch(buildPostFilename({ id: "123456", title: "标题" }), /123456/);
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

test("images saved during sync are added when the page read missed them", () => {
  const images = ["https://pbs.twimg.com/media/A?format=jpg&name=large", "https://pbs.twimg.com/media/B?format=png&name=large"];
  const post = { ...record, note: "", imageUrls: images };
  const markdown = buildPostMarkdown(post, { body: "正文", exportedAt });
  assert.match(markdown, /正文\n\n!\[\]\(https:\/\/pbs\.twimg\.com\/media\/A[^)]*\)\n\n!\[\]\(https:\/\/pbs\.twimg\.com\/media\/B/);
});

test("an image already in the body is not repeated, whatever size or format it was read in", () => {
  const post = { ...record, note: "", imageUrls: ["https://pbs.twimg.com/media/A?format=jpg&name=large"] };
  const markdown = buildPostMarkdown(post, { body: "正文\n\n![](https://pbs.twimg.com/media/A?format=jpg&name=small)", exportedAt });
  assert.equal(markdown.match(/media\/A/g).length, 1);
  const withExtension = buildPostMarkdown(post, { body: "![](https://pbs.twimg.com/media/A.jpg)", exportedAt });
  assert.equal(withExtension.match(/media\/A/g).length, 1);
});

test("an article puts its cover under the source line and keeps inline images in place", () => {
  const article = { ...record, note: "", isArticle: true, imageUrls: ["https://pbs.twimg.com/media/COVER?format=jpg&name=large", "https://pbs.twimg.com/media/IN?format=jpg&name=large"] };
  const markdown = buildPostMarkdown(article, { body: "第一段\n\n![](https://pbs.twimg.com/media/IN?format=jpg&name=small)\n\n第二段", exportedAt });
  assert.match(markdown, /作者：@alice\n\n!\[\]\(https:\/\/pbs\.twimg\.com\/media\/COVER[^)]*\)\n\n第一段/);
  assert.equal(markdown.match(/media\/IN/g).length, 1);
});

test("without a body every saved image is kept, not only the first", () => {
  const post = { ...record, note: "", imageUrls: ["https://pbs.twimg.com/media/A?x=1", "https://pbs.twimg.com/media/B?x=1"] };
  const markdown = buildPostMarkdown(post, { exportedAt });
  assert.match(markdown, /media\/A/);
  assert.match(markdown, /media\/B/);
  assert.match(markdown, /未能读取正文/);
});

test("videos from X's data replace their poster in the body or are added after it", () => {
  const poster = "https://pbs.twimg.com/amplify_video_thumb/9/img/V1.jpg";
  const media = [
    { type: "image", url: "https://pbs.twimg.com/media/P?format=jpg&name=orig" },
    { type: "video", url: "https://video.twimg.com/amplify_video/9/vid/high.mp4", poster },
    { type: "gif", url: "https://video.twimg.com/tweet_video/G.mp4", poster: "https://pbs.twimg.com/tweet_video_thumb/G.jpg" },
  ];
  const post = { ...record, note: "", imageUrls: ["https://pbs.twimg.com/media/QUOTED?format=jpg&name=large"] };
  const markdown = buildPostMarkdown(post, { body: `正文\n\n![](${poster.replace(".jpg", "?format=jpg&name=small")})`, media, exportedAt });
  assert.match(markdown, /正文\n\n\[!\[\]\(https:\/\/pbs\.twimg\.com\/amplify_video_thumb\/9\/img\/V1\.jpg\)\]\(https:\/\/video\.twimg\.com\/amplify_video\/9\/vid\/high\.mp4\)/);
  assert.match(markdown, /!\[\]\(https:\/\/pbs\.twimg\.com\/media\/P\?format=jpg&name=orig\)/);
  assert.match(markdown, /\[!\[\]\(https:\/\/pbs\.twimg\.com\/tweet_video_thumb\/G\.jpg\)\]\(https:\/\/video\.twimg\.com\/tweet_video\/G\.mp4\)/);
  assert.equal(markdown.match(/amplify_video_thumb/g).length, 1);
  // With X's data available, images saved from quoted posts are not mixed in.
  assert.doesNotMatch(markdown, /QUOTED/);
});

test("views are a number property, prefer the count read at download time, and stay empty when unknown", () => {
  assert.match(buildPostMarkdown(record, { exportedAt }), /^views: 12345$/m);
  assert.match(buildPostMarkdown(record, { views: "99999", exportedAt }), /^views: 99999$/m);
  assert.match(buildPostMarkdown({ ...record, views: "" }, { exportedAt }), /^views: $/m);
  assert.match(buildPostMarkdown({ ...record, views: "1.2万" }, { views: "abc", exportedAt }), /^views: $/m);
});

test("article images missing from the page read go back after the paragraph they followed", () => {
  const one = { type: "image", url: "https://pbs.twimg.com/media/ONE?format=jpg&name=orig" };
  const two = { type: "image", url: "https://pbs.twimg.com/media/TWO?format=png&name=orig" };
  const video = { type: "video", url: "https://video.twimg.com/v/v.mp4", poster: "https://pbs.twimg.com/amplify_video_thumb/3/img/P.jpg" };
  const cover = { type: "image", url: "https://pbs.twimg.com/media/COVER?format=jpg&name=orig" };
  const layout = [{ after: "", media: [one] }, { after: "第一段文字。", media: [two, video] }];
  const article = { ...record, note: "", isArticle: true };
  const body = "### 第一节\n\n**第一段**文字。\n\n[第二](https://example.com)段文字。";
  const markdown = buildPostMarkdown(article, { body, media: [cover, one, two, video], layout, exportedAt });
  const order = ["COVER", "ONE", "第一节", "第一段", "TWO", "v.mp4", "第二"].map((part) => markdown.indexOf(part));
  assert.ok(order.every((index) => index > 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(markdown.match(/media\/TWO/g).length, 1);
});

test("an image whose paragraph cannot be found is still kept, after the text", () => {
  const two = { type: "image", url: "https://pbs.twimg.com/media/TWO?format=png&name=orig" };
  const markdown = buildPostMarkdown({ ...record, note: "", isArticle: true }, { body: "完全不同的正文", media: [two], layout: [{ after: "找不到的段落", media: [two] }], exportedAt });
  assert.match(markdown, /完全不同的正文\n\n!\[\]\(https:\/\/pbs\.twimg\.com\/media\/TWO/);
});
