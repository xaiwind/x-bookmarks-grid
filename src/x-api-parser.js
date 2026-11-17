// Parses the bookmark timeline JSON that X's own web client receives.
// The payload is external data: every field is treated as optional and untrusted.

const MAX_SEARCH_DEPTH = 8;
const LONG_POST_THRESHOLD = 3000;
const IMAGE_HOST = "pbs.twimg.com";
const X_HOSTS = ["x.com", "twitter.com", "t.co"];
const COVER_PATH = /\/(media|card_img|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//;
const CARD_IMAGE_KEYS = ["thumbnail_image_original", "summary_photo_image_original", "photo_image_full_size_original", "player_image_original", "thumbnail_image_large", "summary_photo_image_large", "player_image_large"];

/**
 * @param {unknown} payload parsed JSON of a bookmark timeline response
 * @returns {{ tweets: object[], nextCursor: string, hasTimeline: boolean }}
 */
export function parseBookmarkTimeline(payload) {
  const instructions = findInstructions(payload);
  if (!instructions) return { tweets: [], nextCursor: "", hasTimeline: false };
  const tweets = new Map();
  let nextCursor = "";
  for (const instruction of instructions) {
    for (const entry of instructionEntries(instruction)) {
      const cursor = readBottomCursor(entry);
      if (cursor) nextCursor = cursor;
      for (const item of entryItems(entry)) {
        if (item?.promotedMetadata) continue;
        const tweet = parseTweetResult(item?.tweet_results?.result, entry?.sortIndex);
        if (tweet && !tweets.has(tweet.id)) tweets.set(tweet.id, tweet);
      }
    }
  }
  return { tweets: [...tweets.values()], nextCursor, hasTimeline: true };
}

/**
 * @param {unknown} rawResult a `tweet_results.result` object
 * @param {unknown} sortIndex timeline position; larger means bookmarked more recently
 * @returns {object | null}
 */
export function parseTweetResult(rawResult, sortIndex = "") {
  const result = unwrapTweet(rawResult);
  const legacy = isObject(result?.legacy) ? result.legacy : {};
  const id = digits(result?.rest_id) || digits(legacy.id_str);
  if (!id) return null;

  const user = result?.core?.user_results?.result || {};
  const author = cleanHandle(user?.core?.screen_name || user?.legacy?.screen_name);
  const authorName = collapse(user?.core?.name || user?.legacy?.name);
  const article = result?.article?.article_results?.result;
  const isArticle = isObject(article);
  const noteText = result?.note_tweet?.note_tweet_results?.result?.text;
  const text = cleanText(typeof noteText === "string" && noteText ? noteText : visibleText(legacy));
  const media = readMedia(legacy);
  const quoted = unwrapTweet(result?.quoted_status_result?.result);
  const card = readCard(result?.card);
  const articleCover = article?.cover_media?.media_info?.original_img_url;
  const covers = [articleCover, ...media.map((item) => item.url), card.image, ...readMedia(quoted?.legacy).map((item) => item.url)];
  const imageUrls = unique(covers.map(normalizeImageUrl).filter(Boolean));
  const hasVideo = media.some((item) => item.video);
  const textLength = isArticle ? 0 : [...text].length;
  // Media-only posts have nothing to use as a title; the library shows a stand-in in the user's language.
  const title = collapse(isArticle ? article.title : "") || text || card.title;

  return {
    id,
    url: `https://x.com/${author || "i"}/status/${id}`,
    author: author || "unknown",
    authorName,
    title,
    untitled: !title,
    postType: isArticle ? "unknown" : textLength > LONG_POST_THRESHOLD ? "long" : "short",
    classificationVersion: 4,
    classificationVerified: !isArticle,
    isArticle,
    articleUrl: "",
    textLength,
    hasVideo,
    imageUrls,
    coverRatio: firstCoverRatio(article, media),
    externalUrls: readExternalUrls(legacy, result?.note_tweet?.note_tweet_results?.result, card.url),
    views: digits(result?.views?.count),
    createdAt: toIsoDate(legacy.created_at),
    bookmarkSortIndex: digits(sortIndex),
    dataSource: "api",
  };
}

function findInstructions(node, depth = 0) {
  if (!isObject(node) || depth > MAX_SEARCH_DEPTH) return null;
  if (Array.isArray(node.instructions)) return node.instructions;
  for (const value of Object.values(node)) {
    if (!isObject(value) || Array.isArray(value)) continue;
    const found = findInstructions(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function instructionEntries(instruction) {
  if (!isObject(instruction)) return [];
  const entries = Array.isArray(instruction.entries) ? instruction.entries : [];
  return isObject(instruction.entry) ? [...entries, instruction.entry] : entries;
}

function entryItems(entry) {
  const content = entry?.content;
  if (!isObject(content)) return [];
  const moduleItems = Array.isArray(content.items) ? content.items.map((item) => item?.item?.itemContent) : [];
  return [content.itemContent, ...moduleItems].filter(isObject);
}

function readBottomCursor(entry) {
  const content = entry?.content;
  if (!isObject(content)) return "";
  const isBottom = content.cursorType === "Bottom" || /^cursor-bottom/.test(String(entry?.entryId || ""));
  if (!isBottom) return "";
  const value = content.value || content.itemContent?.value;
  return typeof value === "string" ? value : "";
}

function unwrapTweet(result) {
  if (!isObject(result)) return null;
  return isObject(result.tweet) ? result.tweet : result;
}

function visibleText(legacy) {
  const fullText = typeof legacy.full_text === "string" ? legacy.full_text : "";
  const range = legacy.display_text_range;
  if (!Array.isArray(range) || !Number.isInteger(range[0]) || !Number.isInteger(range[1])) return fullText;
  return [...fullText].slice(range[0], range[1]).join("");
}

function cleanText(value) {
  return collapse(decodeEntities(String(value || "").replace(/https?:\/\/t\.co\/\w+/g, " ")));
}

function decodeEntities(value) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function readMedia(legacy) {
  if (!isObject(legacy)) return [];
  const list = legacy.extended_entities?.media || legacy.entities?.media;
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).map((item) => ({
    url: item.media_url_https,
    video: item.type === "video" || item.type === "animated_gif",
    ratio: ratioOf(item.original_info?.width, item.original_info?.height),
  }));
}

function readCard(card) {
  const values = card?.legacy?.binding_values;
  if (!Array.isArray(values)) return { title: "", image: "", url: "" };
  const byKey = new Map(values.filter(isObject).map((item) => [item.key, item.value]));
  const image = CARD_IMAGE_KEYS.map((key) => byKey.get(key)?.image_value?.url).find(Boolean) || "";
  return {
    title: collapse(byKey.get("title")?.string_value),
    image,
    url: String(byKey.get("card_url")?.string_value || ""),
  };
}

function readExternalUrls(legacy, note, cardUrl) {
  const lists = [legacy?.entities?.urls, note?.entity_set?.urls].filter(Array.isArray);
  const urls = lists.flat().map((item) => item?.expanded_url);
  return unique([...urls, cardUrl].map(normalizeExternalUrl).filter(Boolean));
}

function normalizeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/.test(url.protocol)) return "";
    if (X_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return "";
    return url.href;
  } catch {
    return "";
  }
}

/** Keeps only X-hosted cover images and aligns them with the format used by page-scraped covers. */
export function normalizeImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname !== IMAGE_HOST || !COVER_PATH.test(url.pathname)) return "";
    if (!/\/(media|card_img)\//.test(url.pathname)) return url.href;
    const extension = url.pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i)?.[1];
    const format = url.searchParams.get("format") || (extension ? extension.toLowerCase() : "");
    if (extension) url.pathname = url.pathname.slice(0, -(extension.length + 1));
    url.search = "";
    if (format) url.searchParams.set("format", format);
    url.searchParams.set("name", "large");
    return url.href;
  } catch {
    return "";
  }
}

function firstCoverRatio(article, media) {
  const info = article?.cover_media?.media_info;
  return ratioOf(info?.original_img_width, info?.original_img_height) || media.find((item) => item.ratio)?.ratio || 0;
}

function ratioOf(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  return Math.round((width / height) * 1000) / 1000;
}

function toIsoDate(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function cleanHandle(value) {
  const handle = String(value || "").replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,30}$/.test(handle) ? handle : "";
}

function digits(value) {
  const text = String(value ?? "");
  return /^\d{1,30}$/.test(text) ? text : "";
}

function collapse(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values)];
}

function isObject(value) {
  return value !== null && typeof value === "object";
}
