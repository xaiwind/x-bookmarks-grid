import { t, tr } from "./i18n.js";

// Builds the Markdown file for a single bookmark. The body is read on demand and never stored.

const MAX_FILENAME_TITLE = 60;

/**
 * @param {object} record library record
 * @param {{ body?: string, title?: string, exportedAt?: Date }} [options] body is Markdown read from the post page
 * @returns {string}
 */
export function buildPostMarkdown(record, { body = "", title = "", exportedAt = new Date() } = {}) {
  const heading = oneLine(title) || oneLine(record.title) || tr`@${record.author || "unknown"} 的帖子`;
  const frontmatter = [
    "---",
    `title: ${yamlString(heading)}`,
    `author: ${yamlString(record.author ? `@${record.author}` : "")}`,
    `author_name: ${yamlString(record.authorName || "")}`,
    `url: ${yamlString(record.url || "")}`,
    `published: ${yamlString(record.createdAt || "")}`,
    `saved: ${yamlString(exportedAt.toISOString())}`,
    `tweet_id: ${yamlString(record.id || "")}`,
    "---",
  ].join("\n");
  const cover = (record.imageUrls || [])[0];
  const text = String(body || "").trim();
  const sections = [
    frontmatter,
    `# ${heading}`,
    tr`> 原文：${record.url || ""}　作者：@${record.author || "unknown"}`,
    text || [cover ? `![](${cover})` : "", t("（未能读取正文，仅导出已保存的信息。）")].filter(Boolean).join("\n\n"),
    String(record.note || "").trim() ? tr`## 备注\n\n${String(record.note).trim()}` : "",
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/** @returns {string} a filename that is safe on macOS, Windows and Linux */
export function buildPostFilename(record, title = "") {
  const base = (oneLine(title) || oneLine(record.title) || "x-bookmark")
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const short = [...base].slice(0, MAX_FILENAME_TITLE).join("").trim() || "x-bookmark";
  return `${short}-${String(record.id || "post").replace(/[^\w-]/g, "")}.md`;
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function yamlString(value) {
  return JSON.stringify(String(value));
}
