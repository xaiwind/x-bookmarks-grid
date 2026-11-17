import test from "node:test";
import assert from "node:assert/strict";
import { readPostTitleFromPage } from "../extension/title-reader.js";

function titlePage({ pathname, posts = [], tabTitle = "" }) {
  globalThis.location = { pathname };
  globalThis.document = { title: tabTitle, querySelectorAll: (selector) => (selector === 'article[data-testid="tweet"]' ? posts : []) };
  globalThis.setTimeout = (callback) => { callback(); return 0; };
}
const node = (text) => ({ innerText: text, closest: () => null });
const post = (id, { article, text }) => ({
  querySelectorAll: (selector) => {
    if (selector === 'a[href*="/status/"]') return [{ closest: () => null, querySelector: () => ({}), getAttribute: () => `/user/status/${id}` }];
    if (selector === '[data-testid="twitter-article-title"]') return article ? [node(article)] : [];
    if (selector === '[data-testid="tweetText"]') return text ? [node(text)] : [];
    return [];
  },
});

test("title reader prefers the article title, then the post text, then the tab title", async () => {
  const realTimeout = globalThis.setTimeout;
  try {
    titlePage({ pathname: "/user/status/42", posts: [post("42", { article: "  一篇文章的标题 ", text: "正文" })] });
    assert.deepEqual(await readPostTitleFromPage("42"), { ok: true, title: "一篇文章的标题", untitled: false, imageUrls: [] });
    titlePage({ pathname: "/user/status/42", posts: [post("7", { text: "别人的回复" }), post("42", { text: "主帖内容 https://t.co/abc 后半句" })] });
    assert.deepEqual(await readPostTitleFromPage("42"), { ok: true, title: "主帖内容 后半句", untitled: false, imageUrls: [] });
    titlePage({ pathname: "/user/status/42", tabTitle: 'Alice on X: "标签页里的标题" / X' });
    assert.deepEqual(await readPostTitleFromPage("42"), { ok: true, title: "标签页里的标题", untitled: false, imageUrls: [] });
    titlePage({ pathname: "/user/status/999", posts: [post("999", { text: "另一条帖子" })] });
    assert.equal((await readPostTitleFromPage("42")).ok, false);
  } finally {
    globalThis.setTimeout = realTimeout;
    delete globalThis.location;
    delete globalThis.document;
  }
});

test("a media-only post is reported as untitled with its covers instead of failing", async () => {
  const realTimeout = globalThis.setTimeout;
  try {
    const image = (src) => ({ currentSrc: src, src, closest: () => null });
    const mediaPost = post("42", {});
    const base = mediaPost.querySelectorAll;
    mediaPost.querySelectorAll = (selector) => (selector === "img" ? [image("https://pbs.twimg.com/media/PIC?format=jpg&name=small"), image("https://pbs.twimg.com/profile_images/1/a.jpg")] : base(selector));
    titlePage({ pathname: "/user/status/42", posts: [mediaPost] });
    assert.deepEqual(await readPostTitleFromPage("42"), { ok: true, title: "", untitled: true, imageUrls: ["https://pbs.twimg.com/media/PIC?format=jpg&name=small"] });
  } finally {
    globalThis.setTimeout = realTimeout;
    delete globalThis.location;
    delete globalThis.document;
  }
});
