import { t, tr } from "./i18n.js";
import { mediaKey } from "./post-media.js";

// Builds the Markdown file for a single bookmark. The body is read on demand and never stored.

const MAX_FILENAME_TITLE = 60;

/**
 * @param {object} record library record
 * @param {{ body?: string, title?: string, media?: object[], layout?: object[], views?: string, exportedAt?: Date }} [options]
 *   body is Markdown read from the post page; media is the post's own media, layout where an article's inline
 *   media sits, and views its current view count, all from X's data (see post-media.js)
 * @returns {string}
 */
export function buildPostMarkdown(record, { body = "", title = "", media = [], layout = [], views = "", exportedAt = new Date() } = {}) {
  const heading = oneLine(title) || oneLine(record.title) || tr`@${record.author || "unknown"} 的帖子`;
  const frontmatter = [
    "---",
    `title: ${yamlString(heading)}`,
    `author: ${yamlString(record.author ? `@${record.author}` : "")}`,
    `author_name: ${yamlString(record.authorName || "")}`,
    `url: ${yamlString(record.url || "")}`,
    `published: ${yamlString(record.createdAt || "")}`,
    // A bare number, so Obsidian treats it as a Number property that can be sorted and filtered.
    `views: ${viewCount(views) || viewCount(record.views)}`,
    `saved: ${yamlString(exportedAt.toISOString())}`,
    `tweet_id: ${yamlString(record.id || "")}`,
    "---",
  ].join("\n");
  // Media from X's data is complete even when images on the page had not loaded yet. Without it,
  // the image links saved during sync are used. Media already in the body is not repeated.
  const items = Array.isArray(media) && media.length ? media : (record.imageUrls || []).map((url) => ({ type: "image", url }));
  const placed = placeMedia(String(body || "").trim(), items);
  // Article images the page read missed go back after the paragraph they followed, not in a heap at the end.
  const { text, extra } = record.isArticle ? placeByLayout(placed.text, placed.extra, layout) : placed;
  // For an article, the first item is its cover (see x-api-parser and post-media), shown above the text.
  // Media the article places inline is never its cover.
  const inline = new Set((Array.isArray(layout) ? layout : []).flatMap((entry) => (entry?.media || []).map((item) => mediaKey(item?.url))));
  const cover = record.isArticle && text && extra[0] === items[0] && !inline.has(mediaKey(items[0]?.url)) ? [extra[0]] : [];
  const rest = extra.slice(cover.length);
  const sections = [
    frontmatter,
    `# ${heading}`,
    tr`> 原文：${record.url || ""}　作者：@${record.author || "unknown"}`,
    mediaBlock(cover),
    text,
    mediaBlock(rest),
    text ? "" : t("（未能读取正文，仅导出已保存的信息。）"),
    String(record.note || "").trim() ? tr`## 备注\n\n${String(record.note).trim()}` : "",
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/**
 * The note's file name is its title, which Obsidian shows as the note title, so it carries no
 * post id. Two posts with the same title are told apart when saving (see post-download.js).
 * @returns {string} a filename that is safe on macOS, Windows and Linux
 */
export function buildPostFilename(record, title = "") {
  const short = [...safeName(title) || safeName(record.title)].slice(0, MAX_FILENAME_TITLE).join("").trim();
  return `${short || fallbackName(record)}.md`;
}

function safeName(value) {
  return oneLine(value)
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
}

function fallbackName(record) {
  const author = safeName(record.author && record.author !== "unknown" ? record.author : "");
  const date = /^\d{4}-\d{2}-\d{2}/.test(String(record.createdAt || "")) ? String(record.createdAt).slice(0, 10) : "";
  return [author, date].filter(Boolean).join(" ") || "x-bookmark";
}

const IMAGE_LINK = /!\[[^\]]*\]\(([^)\s]+)\)/g;

const mediaMarkdown = (item) => (item.type === "image" ? `![](${item.url})` : `[![](${item.poster || ""})](${item.url})`);

/**
 * Puts each video where the page showed its poster; returns the media the body still lacks.
 * @returns {{ text: string, extra: object[] }}
 */
function placeMedia(body, items) {
  let text = body;
  const extra = [];
  const present = () => new Set([...text.matchAll(IMAGE_LINK)].map((match) => mediaKey(match[1])));
  for (const item of items) {
    if (!item?.url || !/^https:\/\//.test(String(item.url))) continue;
    const inBody = present();
    if (inBody.has(mediaKey(item.url)) || extra.some((other) => mediaKey(other.url) === mediaKey(item.url))) continue;
    if (item.type !== "image" && item.poster && inBody.has(mediaKey(item.poster))) {
      let replaced = false;
      text = text.replace(IMAGE_LINK, (match, url) => {
        if (replaced || mediaKey(url) !== mediaKey(item.poster)) return match;
        replaced = true;
        return mediaMarkdown(item);
      });
      continue;
    }
    extra.push(item);
  }
  return { text, extra };
}

const LAYOUT_ANCHOR_LENGTH = 30;

/** Paragraph text without Markdown syntax or spaces, to compare page text with X's article data. */
function plainText(value) {
  return String(value || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-+]|\d+\.)\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, "");
}

function findParagraph(paragraphs, after, from) {
  const tail = [...plainText(after)].slice(-LAYOUT_ANCHOR_LENGTH).join("");
  if (!tail) return -1;
  for (let index = from; index < paragraphs.length; index += 1) {
    if (plainText(paragraphs[index]).includes(tail)) return index;
  }
  return null;
}

/**
 * @param {string} text body with media already placed
 * @param {object[]} missing media the body still lacks
 * @param {{ after: string, media: object[] }[]} layout
 * @returns {{ text: string, extra: object[] }} extra is what could not be placed
 */
function placeByLayout(text, missing, layout) {
  if (!Array.isArray(layout) || !layout.length || !missing.length) return { text, extra: missing };
  const waiting = new Map(missing.map((item) => [mediaKey(item.url), item]));
  const paragraphs = text ? text.split(/\n{2,}/) : [];
  const inserts = new Map();
  let from = 0;
  for (const entry of layout) {
    const items = (Array.isArray(entry?.media) ? entry.media : []).map((item) => waiting.get(mediaKey(item?.url))).filter(Boolean);
    if (!items.length) continue;
    const index = findParagraph(paragraphs, entry.after, from);
    if (index === null) continue;
    inserts.set(index, [...(inserts.get(index) || []), ...items]);
    for (const item of items) waiting.delete(mediaKey(item.url));
    from = Math.max(from, index);
  }
  const at = (index) => (inserts.get(index) || []).map(mediaMarkdown);
  const rebuilt = [...at(-1), ...paragraphs.flatMap((paragraph, index) => [paragraph, ...at(index)])];
  return { text: rebuilt.join("\n\n"), extra: missing.filter((item) => waiting.has(mediaKey(item.url))) };
}

function mediaBlock(items) {
  return items.map(mediaMarkdown).join("\n\n");
}

function viewCount(value) {
  const text = String(value ?? "").trim();
  return /^\d{1,15}$/.test(text) ? String(Number(text)) : "";
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function yamlString(value) {
  return JSON.stringify(String(value));
}
