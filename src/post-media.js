// Media of one post (photos, videos, GIFs, article images), read from the post data that X's web
// client loads, plus helpers to save that media next to a downloaded note.
// The post data is external input: every field is optional and checked before use.

const IMAGE_HOST = "pbs.twimg.com";
const VIDEO_HOST = "video.twimg.com";
const MEDIA_PATH = /^\/(media|card_img|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//;
const LINK_TARGET = /\]\(([^)\s]+)\)/g;
const VIDEO_WITH_POSTER = /\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)/g;
const IMAGE_LINK = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const PLAIN_LINK = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g;
const MAX_SEARCH_NODES = 200_000;
const ASSETS_FOLDER = "assets";

/**
 * @typedef {{ type: "image", url: string } | { type: "video" | "gif", url: string, poster: string }} PostMedia
 */

const isObject = (value) => value !== null && typeof value === "object";

function parseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Unwraps "TweetWithVisibilityResults" and similar wrappers. */
function unwrap(result) {
  return isObject(result?.tweet) && !result.rest_id ? result.tweet : result;
}

/**
 * @param {unknown} payload parsed JSON of a post detail response
 * @param {string} id
 * @returns {object | null} the tweet result for that post
 */
export function findTweetResult(payload, id) {
  const stack = [payload];
  let visited = 0;
  while (stack.length && visited < MAX_SEARCH_NODES) {
    const node = stack.pop();
    visited += 1;
    if (!isObject(node)) continue;
    if (node.rest_id === String(id) && (isObject(node.legacy) || isObject(node.core))) return node;
    for (const value of Object.values(node)) if (isObject(value)) stack.push(value);
  }
  return null;
}

/** X images at their original size; video posters and other X images as given. */
function imageUrl(value) {
  const url = parseUrl(value);
  if (!url || url.hostname !== IMAGE_HOST || !MEDIA_PATH.test(url.pathname)) return "";
  if (!url.pathname.startsWith("/media/")) return url.href;
  const extension = url.pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i)?.[1];
  const format = url.searchParams.get("format") || (extension ? extension.toLowerCase() : "jpg");
  const path = extension ? url.pathname.slice(0, -(extension.length + 1)) : url.pathname;
  return `https://${IMAGE_HOST}${path}?format=${format}&name=orig`;
}

/** @returns {string} the highest-bitrate mp4, or "" */
function bestVideo(variants) {
  const mp4 = (Array.isArray(variants) ? variants : [])
    .filter((variant) => isObject(variant) && variant.content_type === "video/mp4" && parseUrl(variant.url)?.hostname === VIDEO_HOST)
    .map((variant) => ({ url: parseUrl(variant.url).href, rate: Number(variant.bitrate ?? variant.bit_rate) || 0 }));
  return mp4.sort((a, b) => b.rate - a.rate)[0]?.url || "";
}

function fromLegacyMedia(item) {
  if (!isObject(item)) return null;
  if (item.type === "video" || item.type === "animated_gif") {
    const url = bestVideo(item.video_info?.variants);
    return url ? { type: item.type === "video" ? "video" : "gif", url, poster: imageUrl(item.media_url_https) } : null;
  }
  const url = imageUrl(item.media_url_https);
  return url ? { type: "image", url } : null;
}

function fromArticleMedia(entity) {
  const info = entity?.media_info;
  if (!isObject(info)) return null;
  const video = bestVideo(info.variants || info.video_info?.variants);
  if (video) return { type: info.__typename === "ApiGif" ? "gif" : "video", url: video, poster: imageUrl(info.preview_image?.original_img_url) };
  const url = imageUrl(info.original_img_url);
  return url ? { type: "image", url } : null;
}

/**
 * @param {unknown} rawResult the post's tweet result
 * @returns {PostMedia[]} the post's own media in display order; quoted posts and avatars are left out
 */
export function extractPostMedia(rawResult) {
  const result = unwrap(rawResult);
  if (!isObject(result)) return [];
  const article = result.article?.article_results?.result;
  const legacy = isObject(result.legacy) ? result.legacy : {};
  const legacyMedia = legacy.extended_entities?.media || legacy.entities?.media;
  const found = [
    isObject(article) ? fromArticleMedia(article.cover_media) : null,
    ...(Array.isArray(article?.media_entities) ? article.media_entities.map(fromArticleMedia) : []),
    ...(Array.isArray(legacyMedia) ? legacyMedia.map(fromLegacyMedia) : []),
  ];
  const seen = new Set();
  return found.filter((item) => {
    if (!item) return false;
    const key = mediaKey(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One key for the same media file in any size or format. */
export function mediaKey(value) {
  const url = parseUrl(value);
  if (!url) return String(value || "");
  if (url.hostname === IMAGE_HOST) return `${IMAGE_HOST}${url.pathname.replace(/\.[a-z0-9]+$/i, "")}`;
  return `${url.hostname}${url.pathname}`;
}

/** @returns {string} file extension to save the media with */
export function mediaFileExtension(value) {
  const url = parseUrl(value);
  if (!url) return "jpg";
  const format = (url.searchParams.get("format") || url.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] || "").toLowerCase();
  if (format) return format === "jpeg" ? "jpg" : format;
  return url.hostname === VIDEO_HOST ? "mp4" : "jpg";
}

function isDownloadable(value) {
  const url = parseUrl(value);
  if (!url) return false;
  return url.hostname === VIDEO_HOST || (url.hostname === IMAGE_HOST && MEDIA_PATH.test(url.pathname));
}

/**
 * Lists the X media a note links to and the local file each one is saved as.
 * @param {string} markdown
 * @param {{ id: string }} post
 * @returns {{ url: string, file: string, kind: "image" | "video" }[]} paths are relative to the note
 */
export function planLocalMedia(markdown, { id }) {
  const folder = `${ASSETS_FOLDER}/${String(id || "post").replace(/[^\w-]/g, "") || "post"}`;
  const seen = new Set();
  const plan = [];
  for (const [, url] of String(markdown).matchAll(LINK_TARGET)) {
    const key = mediaKey(url);
    if (!isDownloadable(url) || seen.has(key)) continue;
    seen.add(key);
    const number = String(plan.length + 1).padStart(2, "0");
    plan.push({ url, file: `${folder}/${number}.${mediaFileExtension(url)}`, kind: parseUrl(url).hostname === VIDEO_HOST ? "video" : "image" });
  }
  return plan;
}

/**
 * Points links at the files that were saved. Anything not saved keeps its web link.
 * @param {string} markdown
 * @param {Map<string, string>} saved mediaKey → local file
 */
export function rewriteMediaLinks(markdown, saved) {
  const local = (url) => saved.get(mediaKey(url));
  return String(markdown)
    .replace(VIDEO_WITH_POSTER, (match, alt, poster, video) => (local(video) ? `![${alt}](${local(video)})` : `[![${alt}](${local(poster) || poster})](${video})`))
    .replace(IMAGE_LINK, (match, alt, url) => (local(url) ? `![${alt}](${local(url)})` : match))
    .replace(PLAIN_LINK, (match, text, url) => {
      const file = local(url);
      if (!file) return match;
      return parseUrl(url)?.hostname === VIDEO_HOST ? `![${text}](${file})` : `[${text}](${file})`;
    });
}

/**
 * @param {string} markdown
 * @returns {Map<string, string>} poster mediaKey → video mediaKey, for videos shown as a linked poster
 */
export function videoPosterPairs(markdown) {
  return new Map([...String(markdown).matchAll(VIDEO_WITH_POSTER)].map(([, , poster, video]) => [mediaKey(poster), mediaKey(video)]));
}

function entityList(entityMap) {
  if (Array.isArray(entityMap)) return entityMap.filter(isObject).map((entry) => [String(entry.key), entry.value]);
  return isObject(entityMap) ? Object.entries(entityMap) : [];
}

/**
 * Where each inline image or video of an X Article sits, from the article's rich-text data.
 * @param {unknown} rawResult the post's tweet result
 * @returns {{ after: string, media: PostMedia[] }[]} after is the text of the block the media
 *   follows ("" for the very start)
 */
export function extractArticleLayout(rawResult) {
  const article = unwrap(rawResult)?.article?.article_results?.result;
  const blocks = article?.content_state?.blocks;
  if (!Array.isArray(blocks)) return [];
  const byMediaId = new Map((Array.isArray(article.media_entities) ? article.media_entities : [])
    .filter((entity) => isObject(entity) && entity.media_id)
    .map((entity) => [String(entity.media_id), fromArticleMedia(entity)]));
  const entities = new Map(entityList(article.content_state.entityMap));
  const layout = [];
  let after = "";
  for (const block of blocks) {
    if (!isObject(block)) continue;
    if (block.type !== "atomic") {
      const text = String(block.text || "").trim();
      if (text) after = text;
      continue;
    }
    const media = (Array.isArray(block.entityRanges) ? block.entityRanges : [])
      .map((range) => entities.get(String(range?.key)))
      .filter((entity) => entity?.type === "MEDIA")
      .flatMap((entity) => (Array.isArray(entity.data?.mediaItems) ? entity.data.mediaItems : []))
      .map((item) => byMediaId.get(String(item?.mediaId)))
      .filter(Boolean);
    if (media.length) layout.push({ after, media });
  }
  return layout;
}
