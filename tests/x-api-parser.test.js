import test from "node:test";
import assert from "node:assert/strict";
import { normalizeImageUrl, parseBookmarkTimeline, parseTweetResult } from "../src/x-api-parser.js";

const user = (screenName, name = "Display") => ({ user_results: { result: { legacy: { screen_name: screenName, name } } } });
const tweetEntry = (result, sortIndex = "100") => ({ entryId: `tweet-${result.rest_id}`, sortIndex, content: { itemContent: { tweet_results: { result } } } });
const timeline = (entries) => ({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } });

test("reads tweets, the bottom cursor and bookmark order from a timeline page", () => {
  const page = timeline([
    tweetEntry({ rest_id: "11", core: user("alice"), views: { count: "1234" }, legacy: { full_text: "Hello &amp; welcome https://t.co/abc", created_at: "Wed Oct 10 20:19:24 +0000 2018" } }, "900"),
    { entryId: "cursor-top-1", content: { cursorType: "Top", value: "TOP" } },
    { entryId: "cursor-bottom-1", content: { cursorType: "Bottom", value: "NEXT" } },
  ]);
  const { tweets, nextCursor, hasTimeline } = parseBookmarkTimeline(page);
  assert.equal(hasTimeline, true);
  assert.equal(nextCursor, "NEXT");
  assert.equal(tweets.length, 1);
  assert.deepEqual(
    { id: tweets[0].id, url: tweets[0].url, author: tweets[0].author, title: tweets[0].title, views: tweets[0].views, createdAt: tweets[0].createdAt, order: tweets[0].bookmarkSortIndex },
    { id: "11", url: "https://x.com/alice/status/11", author: "alice", title: "Hello & welcome", views: "1234", createdAt: "2018-10-10T20:19:24.000Z", order: "900" },
  );
  assert.equal(tweets[0].postType, "short");
  assert.equal(tweets[0].classificationVerified, true);
  assert.equal(tweets[0].dataSource, "api");
});

test("reports a missing timeline instead of pretending the list is empty", () => {
  assert.deepEqual(parseBookmarkTimeline({ errors: [{ message: "Rate limit" }] }), { tweets: [], nextCursor: "", hasTimeline: false });
  assert.deepEqual(parseBookmarkTimeline(null), { tweets: [], nextCursor: "", hasTimeline: false });
  assert.equal(parseBookmarkTimeline(timeline([])).hasTimeline, true);
});

test("skips tombstones, promoted items and duplicate ids", () => {
  const good = { rest_id: "5", core: user("bob"), legacy: { full_text: "kept" } };
  const page = timeline([
    tweetEntry(good),
    tweetEntry(good),
    { entryId: "tweet-6", content: { itemContent: { tweet_results: { result: { __typename: "TweetTombstone" } } } } },
    { entryId: "promoted-7", content: { itemContent: { promotedMetadata: {}, tweet_results: { result: { rest_id: "7", legacy: { full_text: "ad" } } } } } },
    { entryId: "tweet-8", content: { itemContent: { tweet_results: {} } } },
  ]);
  assert.deepEqual(parseBookmarkTimeline(page).tweets.map((tweet) => tweet.id), ["5"]);
});

test("unwraps visibility wrappers and the newer user core shape", () => {
  const tweet = parseTweetResult({ __typename: "TweetWithVisibilityResults", tweet: { rest_id: "9", core: { user_results: { result: { core: { screen_name: "carol", name: "Carol" } } } }, legacy: { full_text: "wrapped" } } });
  assert.equal(tweet.author, "carol");
  assert.equal(tweet.authorName, "Carol");
  assert.equal(tweet.title, "wrapped");
});

test("uses the full note text for long posts and classifies by its length", () => {
  const body = "长".repeat(3001);
  const tweet = parseTweetResult({ rest_id: "20", core: user("dave"), legacy: { full_text: "截断…" }, note_tweet: { note_tweet_results: { result: { text: body, entity_set: { urls: [{ expanded_url: "https://example.com/a" }] } } } } });
  assert.equal(tweet.textLength, 3001);
  assert.equal(tweet.postType, "long");
  assert.deepEqual(tweet.externalUrls, ["https://example.com/a"]);
});

test("articles use the article title and cover and stay unverified until their length is read", () => {
  const tweet = parseTweetResult({
    rest_id: "30", core: user("erin"), legacy: { full_text: "https://t.co/x" },
    article: { article_results: { result: { title: "  一篇 X 文章 ", cover_media: { media_info: { original_img_url: "https://pbs.twimg.com/media/COVER.jpg", original_img_width: 1200, original_img_height: 600 } } } } },
  });
  assert.equal(tweet.isArticle, true);
  assert.equal(tweet.title, "一篇 X 文章");
  assert.equal(tweet.postType, "unknown");
  assert.equal(tweet.classificationVerified, false);
  assert.deepEqual(tweet.imageUrls, ["https://pbs.twimg.com/media/COVER?format=jpg&name=large"]);
  assert.equal(tweet.coverRatio, 2);
});

test("collects main media before card and quoted covers and detects video", () => {
  const tweet = parseTweetResult({
    rest_id: "40", core: user("fay"),
    legacy: {
      full_text: "@x @y look https://t.co/m", display_text_range: [6, 10],
      extended_entities: { media: [
        { type: "video", media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg", original_info: { width: 720, height: 1280 } },
        { type: "photo", media_url_https: "https://pbs.twimg.com/media/MAIN.png" },
        { type: "photo", media_url_https: "https://evil.example/media/x.jpg" },
      ] },
      entities: { urls: [{ expanded_url: "https://example.com/post" }, { expanded_url: "https://x.com/a/status/1" }, { expanded_url: "javascript:alert(1)" }] },
    },
    card: { legacy: { binding_values: [{ key: "title", value: { string_value: "Card title" } }, { key: "thumbnail_image_original", value: { image_value: { url: "https://pbs.twimg.com/card_img/9/c?format=jpg&name=orig" } } }] } },
    quoted_status_result: { result: { rest_id: "41", legacy: { extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/QUOTED.jpg" }] } } } },
  });
  assert.equal(tweet.title, "look");
  assert.equal(tweet.hasVideo, true);
  assert.equal(tweet.coverRatio, 0.563);
  assert.deepEqual(tweet.imageUrls, [
    "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg",
    "https://pbs.twimg.com/media/MAIN?format=png&name=large",
    "https://pbs.twimg.com/card_img/9/c?format=jpg&name=large",
    "https://pbs.twimg.com/media/QUOTED?format=jpg&name=large",
  ]);
  assert.deepEqual(tweet.externalUrls, ["https://example.com/post"]);
});

test("falls back to a card title or a readable placeholder when there is no text", () => {
  const withCard = parseTweetResult({ rest_id: "50", core: user("gus"), legacy: { full_text: "https://t.co/z" }, card: { legacy: { binding_values: [{ key: "title", value: { string_value: "Linked page" } }] } } });
  assert.equal(withCard.title, "Linked page");
  const mediaOnly = parseTweetResult({ rest_id: "51", core: user("gus", "Gus"), legacy: { full_text: "", extended_entities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/A.jpg" }] } } });
  assert.deepEqual({ title: mediaOnly.title, untitled: mediaOnly.untitled }, { title: "", untitled: true });
  assert.equal(withCard.untitled, false);
});

test("missing or malformed fields never throw and never produce unsafe values", () => {
  assert.equal(parseTweetResult(null), null);
  assert.equal(parseTweetResult({ rest_id: "not-a-number" }), null);
  const bare = parseTweetResult({ rest_id: "60", core: { user_results: { result: { legacy: { screen_name: "bad/../name" } } } }, legacy: { created_at: "nonsense" }, views: { count: "1e9" } });
  assert.deepEqual({ url: bare.url, author: bare.author, createdAt: bare.createdAt, views: bare.views, images: bare.imageUrls }, { url: "https://x.com/i/status/60", author: "unknown", createdAt: "", views: "", images: [] });
  assert.equal(normalizeImageUrl("http://pbs.twimg.com/media/A.jpg"), "");
  assert.equal(normalizeImageUrl("https://pbs.twimg.com/profile_images/1/a.jpg"), "");
});
