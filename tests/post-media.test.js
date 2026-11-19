import test from "node:test";
import assert from "node:assert/strict";
import { extractArticleLayout, videoPosterPairs, extractPostMedia, findTweetResult, mediaFileExtension, mediaKey, planLocalMedia, rewriteMediaLinks } from "../src/post-media.js";

const photo = { type: "photo", media_url_https: "https://pbs.twimg.com/media/P1.jpg" };
const video = {
  type: "video",
  media_url_https: "https://pbs.twimg.com/amplify_video_thumb/9/img/V1.jpg",
  video_info: { variants: [
    { content_type: "application/x-mpegURL", url: "https://video.twimg.com/amplify_video/9/pl/a.m3u8" },
    { content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/amplify_video/9/vid/640x360/low.mp4?tag=1" },
    { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/amplify_video/9/vid/1280x720/high.mp4?tag=1" },
  ] },
};
const gif = { type: "animated_gif", media_url_https: "https://pbs.twimg.com/tweet_video_thumb/G1.jpg", video_info: { variants: [{ content_type: "video/mp4", bitrate: 0, url: "https://video.twimg.com/tweet_video/G1.mp4" }] } };

function tweet(id, extra = {}) {
  return {
    __typename: "Tweet",
    rest_id: id,
    core: { user_results: { result: { legacy: { profile_image_url_https: "https://pbs.twimg.com/profile_images/1/avatar.jpg" } } } },
    legacy: { id_str: id, extended_entities: { media: [photo, video, gif] } },
    ...extra,
  };
}

test("finds the requested post anywhere in a detail response, including wrapped results", () => {
  const payload = { data: { threaded_conversation_with_injections_v2: { instructions: [{ entries: [
    { content: { itemContent: { tweet_results: { result: tweet("1") } } } },
    { content: { itemContent: { tweet_results: { result: { __typename: "TweetWithVisibilityResults", tweet: tweet("2") } } } } },
  ] }] } } };
  assert.equal(findTweetResult(payload, "1").rest_id, "1");
  assert.equal(findTweetResult(payload, "2").rest_id, "2");
  assert.equal(findTweetResult(payload, "3"), null);
  assert.equal(findTweetResult(null, "1"), null);
});

test("collects photos at original size and the best mp4 of each video, skipping avatars and quoted posts", () => {
  const result = tweet("1", { quoted_status_result: { result: tweet("2", { legacy: { extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/QUOTED.jpg" }] } } }) } });
  const media = extractPostMedia(result);
  assert.deepEqual(media, [
    { type: "image", url: "https://pbs.twimg.com/media/P1?format=jpg&name=orig" },
    { type: "video", url: "https://video.twimg.com/amplify_video/9/vid/1280x720/high.mp4?tag=1", poster: "https://pbs.twimg.com/amplify_video_thumb/9/img/V1.jpg" },
    { type: "gif", url: "https://video.twimg.com/tweet_video/G1.mp4", poster: "https://pbs.twimg.com/tweet_video_thumb/G1.jpg" },
  ]);
});

test("article covers and inline article media are collected once", () => {
  const result = {
    rest_id: "5",
    legacy: {},
    article: { article_results: { result: {
      cover_media: { media_info: { original_img_url: "https://pbs.twimg.com/media/COVER.jpg" } },
      media_entities: [
        { media_info: { __typename: "ApiImage", original_img_url: "https://pbs.twimg.com/media/IN1.png" } },
        { media_info: { __typename: "ApiImage", original_img_url: "https://pbs.twimg.com/media/COVER.jpg" } },
        { media_info: { __typename: "ApiVideo", preview_image: { original_img_url: "https://pbs.twimg.com/amplify_video_thumb/7/img/T.jpg" }, variants: [{ content_type: "video/mp4", bit_rate: 100, url: "https://video.twimg.com/amplify_video/7/vid/a.mp4" }] } },
      ],
    } } },
  };
  assert.deepEqual(extractPostMedia(result).map((item) => [item.type, item.url]), [
    ["image", "https://pbs.twimg.com/media/COVER?format=jpg&name=orig"],
    ["image", "https://pbs.twimg.com/media/IN1?format=png&name=orig"],
    ["video", "https://video.twimg.com/amplify_video/7/vid/a.mp4"],
  ]);
});

test("missing or malformed media is ignored", () => {
  assert.deepEqual(extractPostMedia(null), []);
  assert.deepEqual(extractPostMedia({ legacy: { extended_entities: { media: [{ type: "video", video_info: { variants: [] } }, { media_url_https: "http://evil.example/x.jpg" }] } } }), []);
});

test("the same image in different sizes or formats has one key", () => {
  assert.equal(mediaKey("https://pbs.twimg.com/media/A?format=jpg&name=small"), mediaKey("https://pbs.twimg.com/media/A.jpg"));
  assert.notEqual(mediaKey("https://pbs.twimg.com/media/A?format=jpg"), mediaKey("https://pbs.twimg.com/media/B?format=jpg"));
  assert.equal(mediaKey("https://video.twimg.com/tweet_video/G1.mp4?tag=3"), "video.twimg.com/tweet_video/G1.mp4");
});

test("file extensions come from the format, the path or the media kind", () => {
  assert.equal(mediaFileExtension("https://pbs.twimg.com/media/A?format=png&name=orig"), "png");
  assert.equal(mediaFileExtension("https://pbs.twimg.com/media/A.jpg"), "jpg");
  assert.equal(mediaFileExtension("https://video.twimg.com/x/a.mp4?tag=1"), "mp4");
  assert.equal(mediaFileExtension("https://pbs.twimg.com/card_img/1/abc?format=webp"), "webp");
  assert.equal(mediaFileExtension("https://pbs.twimg.com/card_img/1/abc"), "jpg");
});

test("local media gets numbered files next to the note and links are rewritten", () => {
  const poster = "https://pbs.twimg.com/amplify_video_thumb/9/img/V1.jpg";
  const videoUrl = "https://video.twimg.com/v/a.mp4";
  const markdown = `正文\n\n![](https://pbs.twimg.com/media/A?format=jpg&name=orig)\n\n![](https://pbs.twimg.com/media/A?format=jpg&name=small)\n\n[![](${poster})](${videoUrl})\n\n[链接](https://example.com/page)`;
  const plan = planLocalMedia(markdown, { id: "42" });
  assert.deepEqual(plan.map(({ url, file, kind }) => [url, file, kind]), [
    ["https://pbs.twimg.com/media/A?format=jpg&name=orig", "assets/42/01.jpg", "image"],
    [poster, "assets/42/02.jpg", "image"],
    [videoUrl, "assets/42/03.mp4", "video"],
  ]);
  const all = new Map(plan.map(({ url, file }) => [mediaKey(url), file]));
  const local = rewriteMediaLinks(markdown, all);
  assert.match(local, /!\[\]\(assets\/42\/01\.jpg\)\n\n!\[\]\(assets\/42\/01\.jpg\)/);
  // A saved video is embedded directly; its poster is no longer needed.
  assert.match(local, /\n!\[\]\(assets\/42\/03\.mp4\)\n/);
  assert.doesNotMatch(local, /02\.jpg/);
  assert.match(local, /\[链接\]\(https:\/\/example\.com\/page\)/);
  // A video that could not be saved keeps its web link behind the local poster.
  const posterOnly = rewriteMediaLinks(markdown, new Map([[mediaKey(poster), "assets/42/02.jpg"]]));
  assert.match(posterOnly, /\[!\[\]\(assets\/42\/02\.jpg\)\]\(https:\/\/video\.twimg\.com\/v\/a\.mp4\)/);
  // Nothing saved: every web link stays.
  assert.equal(rewriteMediaLinks(markdown, new Map()), markdown);
});

test("only X media hosts are downloaded", () => {
  const plan = planLocalMedia("![](https://evil.example/a.jpg)\n\n![](https://pbs.twimg.com/profile_images/1/a.jpg)\n\n![](http://pbs.twimg.com/media/A.jpg)", { id: "1" });
  assert.deepEqual(plan, []);
});

test("linked posters are paired with their videos so a saved video needs no poster file", () => {
  const pairs = videoPosterPairs("[![](https://pbs.twimg.com/amplify_video_thumb/1/img/P.jpg)](https://video.twimg.com/v/1.mp4)\n\n![](https://pbs.twimg.com/media/A.jpg)");
  assert.deepEqual([...pairs], [["pbs.twimg.com/amplify_video_thumb/1/img/P", "video.twimg.com/v/1.mp4"]]);
});

const articleResult = (entityMap) => ({
  rest_id: "5",
  legacy: {},
  article: { article_results: { result: {
    cover_media: { media_info: { original_img_url: "https://pbs.twimg.com/media/COVER.jpg" } },
    media_entities: [
      { media_id: "111", media_info: { __typename: "ApiImage", original_img_url: "https://pbs.twimg.com/media/ONE.jpg" } },
      { media_id: "222", media_info: { __typename: "ApiImage", original_img_url: "https://pbs.twimg.com/media/TWO.png" } },
      { media_id: "333", media_info: { __typename: "ApiVideo", preview_image: { original_img_url: "https://pbs.twimg.com/amplify_video_thumb/3/img/P.jpg" }, variants: [{ content_type: "video/mp4", bitrate: 1, url: "https://video.twimg.com/amplify_video/3/vid/v.mp4" }] } },
    ],
    content_state: {
      blocks: [
        { type: "atomic", text: " ", entityRanges: [{ key: 0, offset: 0, length: 1 }] },
        { type: "header-two", text: "第一节", entityRanges: [] },
        { type: "unstyled", text: "第一段文字。", entityRanges: [] },
        { type: "atomic", text: " ", entityRanges: [{ key: 1, offset: 0, length: 1 }] },
        { type: "unstyled", text: "", entityRanges: [] },
        { type: "unstyled", text: "第二段文字。", entityRanges: [{ key: 2, offset: 0, length: 2 }] },
        { type: "atomic", text: " ", entityRanges: [{ key: 3, offset: 0, length: 1 }] },
      ],
      entityMap,
    },
  } } },
});
const ENTITIES = [
  { key: "0", value: { type: "MEDIA", data: { mediaItems: [{ mediaId: "111" }] } } },
  { key: "1", value: { type: "MEDIA", data: { mediaItems: [{ mediaId: "222" }, { mediaId: "333" }] } } },
  { key: "2", value: { type: "LINK", data: { url: "https://example.com" } } },
  { key: "3", value: { type: "MEDIA", data: { mediaItems: [{ mediaId: "999" }] } } },
];

test("article layout says which text each inline image follows", () => {
  const layout = extractArticleLayout(articleResult(ENTITIES));
  assert.deepEqual(layout.map((entry) => [entry.after, entry.media.map((item) => item.url)]), [
    ["", ["https://pbs.twimg.com/media/ONE?format=jpg&name=orig"]],
    ["第一段文字。", ["https://pbs.twimg.com/media/TWO?format=png&name=orig", "https://video.twimg.com/amplify_video/3/vid/v.mp4"]],
  ]);
});

test("article layout accepts an entity map keyed by object and ignores what it cannot read", () => {
  const keyed = Object.fromEntries(ENTITIES.map(({ key, value }) => [key, value]));
  assert.equal(extractArticleLayout(articleResult(keyed)).length, 2);
  assert.deepEqual(extractArticleLayout({ rest_id: "1", legacy: {} }), []);
  assert.deepEqual(extractArticleLayout(null), []);
});
