import { t, tr } from "./i18n.js";

const DEFAULT_CATEGORY = "未分类";

export function extractTweetId(url) {
  if (!url) return null;
  const match = String(url).match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

export function findNewTweets(tweets, seen = {}) {
  return tweets.filter((tweet) => tweet?.id && !seen[tweet.id]);
}

export function normalizeTweet(input, category = DEFAULT_CATEGORY) {
  const id = input.id || extractTweetId(input.url);
  const now = new Date().toISOString();
  return {
    id,
    url: normalizeTweetUrl(input.url, input.author, id),
    author: stripAt(input.author || input.username || "unknown"),
    title: createTitle(input.title || input.text || id),
    text: (input.text || "").trim(),
    views: (input.views || "").trim(),
    createdAt: input.createdAt || "",
    category: sanitizeCategory(category || DEFAULT_CATEGORY),
    postType: input.postType || "short",
    classificationVersion: input.classificationVersion || 0,
    classificationVerified: Boolean(input.classificationVerified),
    isArticle: Boolean(input.isArticle),
    articleUrl: input.articleUrl || "",
    textLength: Number.isFinite(input.textLength) ? input.textLength : [...String(input.text || "").trim()].length,
    hasVideo: Boolean(input.hasVideo || input.videoUrl || (input.videoUrls || []).length),
    imageUrls: unique(input.imageUrls || []),
    externalUrls: unique(input.externalUrls || []),
    syncedAt: input.syncedAt || now,
    downloadedAt: input.downloadedAt || "",
    syncStatus: input.syncStatus || "indexed",
    articleStatus: input.articleStatus || "link_only",
    contentStatus: input.contentStatus || (input.text ? "content_synced" : "url_only"),
  };
}

export function selectCategory(tweet = {}, settings = {}) {
  const mode = settings.categoryMode || "custom";
  const fallback = settings.fallbackCategory || DEFAULT_CATEGORY;
  if (mode === "x_folder") {
    return sanitizeCategory(tweet.bookmarkFolder || fallback);
  }
  if (mode === "custom") {
    return sanitizeCategory(settings.customCategory || fallback);
  }
  return sanitizeCategory(fallback);
}

export function shouldIncludePostType(tweet = {}, filter = "all") {
  if (!filter || filter === "all") return true;
  return (tweet.postType || "short") === filter;
}

export function createSafeTweetFilename(tweet) {
  const title = slugify(tweet.title || tweet.text || tweet.url || "x-bookmark");
  return `${title}-${tweet.id}.md`;
}

export function buildTweetMarkdown(tweet) {
  const normalized = normalizeTweet(tweet, tweet.category);
  const imageBlock = normalized.imageUrls.length
    ? normalized.imageUrls.map((url) => `![](${url})`).join("\n\n")
    : "- ";
  const linkBlock = normalized.externalUrls.length
    ? normalized.externalUrls.map((url) => `- ${url}`).join("\n")
    : "- ";

  return `---\nsource: x\ntweet_id: "${escapeYaml(normalized.id)}"\ntitle: "${escapeYaml(normalized.title)}"\nurl: "${escapeYaml(normalized.url)}"\nauthor: "${escapeYaml(normalized.author)}"\ncategory: "${escapeYaml(normalized.category)}"\npost_type: ${normalized.postType}\nsync_status: ${normalized.syncStatus}\ncontent_status: content_synced\narticle_status: ${normalized.articleStatus}\nsynced_at: ${normalized.syncedAt}\ndownloaded_at: ${normalized.downloadedAt || ""}\n---\n\n# ${normalized.title}\n\n原链接：${normalized.url}\n\n作者：@${normalized.author}\n推文ID：${normalized.id}\n同步时间：${normalized.syncedAt}\n浏览量：${normalized.views || ""}\n状态：待整理\n\n## 正文\n\n${normalized.text || "- "}\n\n## 图片\n\n${imageBlock}\n\n## 外部链接\n\n${linkBlock}\n\n## 后续整理\n\n- \n`;
}

export function buildUrlOnlyMarkdown(tweet) {
  const normalized = normalizeTweet({ ...tweet, text: "" }, tweet.category);
  return `---\nsource: x\ntweet_id: "${escapeYaml(normalized.id)}"\ntitle: "${escapeYaml(normalized.title)}"\nurl: "${escapeYaml(normalized.url)}"\nauthor: "${escapeYaml(normalized.author)}"\ncategory: "${escapeYaml(normalized.category)}"\npost_type: ${normalized.postType}\nsync_status: indexed\ncontent_status: url_only\narticle_status: link_only\nsynced_at: ${normalized.syncedAt}\ndownloaded_at: \n---\n\n# ${normalized.title}\n\n原文链接：${normalized.url}\n\n作者：@${normalized.author}\n推文ID：${normalized.id}\n同步时间：${normalized.syncedAt}\n浏览量：${normalized.views || ""}\n状态：URL 已索引，内容待同步\n\n## 后续内容同步\n\n- \n\n## 后续整理\n\n- \n`;
}

export function buildIndexMarkdown(records) {
  const groups = new Map();
  for (const record of records) {
    const category = record.category || DEFAULT_CATEGORY;
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(record);
  }

  let markdown = "# 推特收藏同步索引\n\n";
  for (const category of [...groups.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"))) {
    markdown += `## ${category}\n\n`;
    for (const record of groups.get(category)) {
      const noteName = basenameWithoutExt(record.file || createSafeTweetFilename(record));
      const sync = statusLabel(record.syncStatus);
      const article = articleStatusLabel(record.articleStatus);
      const content = contentStatusLabel(record.contentStatus);
      const summary = summarize(record.title || record.text || record.url || "");
      markdown += `- [${sync}] [${content}] [${article}] [[${noteName}]] - @${record.author || "unknown"} - ${summary}\n`;
    }
    markdown += "\n";
  }
  return markdown;
}

export function buildSeenRecord(tweet, file) {
  return {
    url: tweet.url,
    author: tweet.author,
    title: tweet.title,
    views: tweet.views,
    category: tweet.category,
    post_type: tweet.postType,
    file,
    sync_status: tweet.syncStatus,
    content_status: tweet.contentStatus,
    article_status: tweet.articleStatus,
    synced_at: tweet.syncedAt,
    downloaded_at: tweet.downloadedAt || null,
  };
}

export function mergeIndexedRecord(existing = {}, indexed = {}) {
  if (existing.dataSource === "api" && indexed.dataSource !== "api") return mergePageDataIntoApiRecord(existing, indexed);
  const keepVerified = existing.classificationVerified && existing.classificationVersion >= 4 && !indexed.classificationVerified;
  return {
    ...existing,
    ...indexed,
    ...(keepVerified ? { classificationVerified: true, classificationVersion: existing.classificationVersion, postType: existing.postType, isArticle: existing.isArticle, textLength: existing.textLength } : {}),
    title: existing.titleEdited ? existing.title : usefulTitle(indexed.title) || usefulTitle(indexed.text) || existing.title || indexed.title,
    articleUrl: indexed.articleUrl || existing.articleUrl || "",
    text: existing.text || indexed.text || "",
    imageUrls: [...new Set([...(indexed.imageUrls || []), ...(existing.imageUrls || [])])],
    externalUrls: [...new Set([...(existing.externalUrls || []), ...(indexed.externalUrls || [])])],
    hasVideo: Boolean(existing.hasVideo || indexed.hasVideo),
    file: existing.file || indexed.file,
    contentStatus: existing.contentStatus || existing.content_status || indexed.contentStatus,
    articleStatus: existing.articleStatus || existing.article_status || indexed.articleStatus,
    syncStatus: existing.syncStatus || existing.sync_status || indexed.syncStatus,
    downloadedAt: existing.downloadedAt || existing.downloaded_at || indexed.downloadedAt || "",
  };
}

// Records read from X's timeline data are more complete than what a rendered page shows,
// so page-scraped fields only add covers and links instead of replacing titles or classification.
function mergePageDataIntoApiRecord(existing, indexed) {
  return {
    ...existing,
    articleUrl: existing.articleUrl || indexed.articleUrl || "",
    imageUrls: [...new Set([...(existing.imageUrls || []), ...(indexed.imageUrls || [])])],
    externalUrls: [...new Set([...(existing.externalUrls || []), ...(indexed.externalUrls || [])])],
    hasVideo: Boolean(existing.hasVideo || indexed.hasVideo),
  };
}

/** X shows an author's follower count next to article cards; it is never a post title. */
export function isFollowerCountText(value) {
  return /^[\d,.]+\s*[KMB万千亿]?\s*(位)?(粉丝|关注者|followers?|following|正在关注)$/i.test(String(value || "").trim());
}

/** Whether a record has no real title yet (empty, a placeholder, a bare link or a follower count). */
export function needsTitleBackfill(record = {}) {
  // Posts that only contain media have no text to use as a title; that is final, not missing.
  return !record.untitled && !record.hidden && !usefulTitle(record.title);
}

/** Title to show for a record, with a readable stand-in when the post has no usable title. */
export function displayTitle(record = {}) {
  const stored = usefulTitle(record.title);
  if (stored) return stored;
  const author = record.author || "unknown";
  const state = record.untitled ? t("（无文字）") : t("（暂无标题）");
  if (record.isArticle) return tr`@${author} 的文章${state}`;
  if (record.hasVideo) return tr`@${author} 的视频${state}`;
  if ((record.imageUrls || []).length) return tr`@${author} 的图片${state}`;
  return tr`@${author} 的帖子${state}`;
}

function contentStatusLabel(status) {
  if (status === "content_synced") return "CONTENT_SYNCED";
  if (status === "content_failed") return "CONTENT_FAILED";
  return "URL_ONLY";
}

function usefulTitle(value) {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  if (!title || /^https?:\/\//i.test(title)) return "";
  if (/^X书签-\d+$/.test(title) || title === "X 书签" || title === "X书签") return "";
  if (isFollowerCountText(title)) return "";
  return title;
}

function normalizeTweetUrl(url, author, id) {
  if (url) return String(url).replace("twitter.com", "x.com").split("?")[0];
  if (author && id) return `https://x.com/${stripAt(author)}/status/${id}`;
  return "";
}

function createTitle(value) {
  const raw = String(value || "").trim();
  if (/^\d+$/.test(raw)) return `X书签-${raw}`;
  if (/^https?:\/\//i.test(raw)) {
    const id = extractTweetId(raw);
    return id ? `X书签-${id}` : "X书签";
  }
  const title = raw
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return title || "X 书签";
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function sanitizeCategory(value) {
  return String(value || DEFAULT_CATEGORY)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim() || DEFAULT_CATEGORY;
}

function stripAt(value) {
  return String(value).replace(/^@/, "");
}

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unknown";
}

function escapeYaml(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function basenameWithoutExt(file) {
  const base = String(file).split("/").pop() || file;
  return base.replace(/\.md$/i, "");
}

function summarize(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 80);
}

function statusLabel(status) {
  if (status === "failed") return "FAILED";
  if (status === "skipped") return "SKIPPED";
  return "INDEXED";
}

function articleStatusLabel(status) {
  if (status === "downloaded") return "ARTICLE_DOWNLOADED";
  if (status === "failed") return "ARTICLE_FAILED";
  if (status === "partial") return "ARTICLE_PARTIAL";
  return "LINK_ONLY";
}
