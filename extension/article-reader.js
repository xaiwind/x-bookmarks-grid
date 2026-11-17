// Runs inside a temporary X tab when the user downloads one post. It converts the post or
// X Article that is on screen into Markdown and returns it; nothing is stored by the extension.
export async function readPostMarkdownFromPage(expectedId) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const quoteSelector = '[data-testid="quoteTweet"], [data-testid="quoteTweetContainer"], [data-testid="quotedTweet"], article[data-testid="tweet"] article[data-testid="tweet"]';
  const idPattern = new RegExp(`/(?:status|article)/${expectedId}(?:[/?#]|$)`);
  const BLOCK_TAGS = /^(div|p|h[1-6]|ul|ol|li|blockquote|pre|section|figure|article)$/;
  const MEDIA_IMAGE = /^https:\/\/pbs\.twimg\.com\/(media|card_img|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//;
  const tagOf = (node) => String(node.tagName || "").toLowerCase();

  const inline = (node) => {
    if (node.nodeType === 3) return String(node.nodeValue || "").replace(/ /g, " ");
    if (node.nodeType !== 1 || node.matches?.(quoteSelector)) return "";
    const tag = tagOf(node);
    if (tag === "br") return "\n";
    if (tag === "img") {
      const src = String(node.currentSrc || node.src || "");
      if (/\/emoji\//.test(src)) return node.alt || "";
      return MEDIA_IMAGE.test(src) ? `\n\n![](${src})\n\n` : "";
    }
    if (tag === "script" || tag === "style" || tag === "svg" || tag === "button") return "";
    const inner = [...node.childNodes].map(inline).join("");
    const trimmed = inner.trim();
    if (!trimmed || trimmed.startsWith("![](")) return inner;
    if (tag === "a") {
      const href = String(node.href || "");
      return /^https?:\/\//.test(href) ? `[${trimmed}](${href})` : inner;
    }
    if (tag === "code") return `\`${trimmed}\``;
    const weight = String(node.style?.fontWeight || "");
    if (tag === "strong" || tag === "b" || weight === "bold" || Number(weight) >= 600) return `**${trimmed}**`;
    if (tag === "em" || tag === "i" || node.style?.fontStyle === "italic") return `*${trimmed}*`;
    return inner;
  };

  const prefixOf = (node) => {
    const tag = tagOf(node);
    const cls = String(node.className || "");
    if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Math.min(Number(tag[1]) + 1, 6))} `;
    if (/header-one/.test(cls)) return "## ";
    if (/header-two/.test(cls)) return "### ";
    if (tag === "blockquote" || /blockquote/.test(cls)) return "> ";
    if (tag === "li") {
      const list = node.parentElement;
      return tagOf(list) === "ol" ? `${[...list.children].indexOf(node) + 1}. ` : "- ";
    }
    return null;
  };

  const toMarkdown = (root) => {
    const blocks = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches?.(quoteSelector)) continue;
        if (tagOf(child) === "pre") {
          blocks.push(`\`\`\`\n${String(child.innerText || child.textContent || "").trim()}\n\`\`\``);
          continue;
        }
        const prefix = prefixOf(child);
        const hasBlocks = [...child.children].some((item) => BLOCK_TAGS.test(tagOf(item)));
        if (prefix !== null || !hasBlocks) {
          const text = inline(child).trim();
          if (text) blocks.push(`${prefix || ""}${text}`);
        } else {
          walk(child);
        }
      }
    };
    walk(root);
    return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  };

  let previousLength = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (idPattern.test(location.pathname)) {
      const rich = document.querySelector('[data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"]');
      const articleTitle = document.querySelector('[data-testid="twitter-article-title"]');
      let result = null;
      if (rich && !rich.closest(quoteSelector)) {
        result = { isArticle: true, title: String(articleTitle?.innerText || articleTitle?.textContent || "").replace(/\s+/g, " ").trim(), markdown: toMarkdown(rich) };
      } else if (attempt >= 4) {
        const post = [...document.querySelectorAll('article[data-testid="tweet"]')].find((item) => [...item.querySelectorAll('a[href*="/status/"]')].some((link) => !link.closest(quoteSelector) && link.querySelector("time") && idPattern.test(link.getAttribute("href") || "")));
        const text = post && [...post.querySelectorAll('[data-testid="tweetText"]')].find((node) => !node.closest(quoteSelector));
        if (post) {
          const images = [...post.querySelectorAll("img")].filter((image) => !image.closest(quoteSelector)).map((image) => String(image.currentSrc || image.src || "")).filter((src) => MEDIA_IMAGE.test(src));
          const body = text ? inline(text).trim() : "";
          result = { isArticle: false, title: "", markdown: [body, ...[...new Set(images)].map((src) => `![](${src})`)].filter(Boolean).join("\n\n") };
        }
      }
      if (result?.markdown) {
        stable = result.markdown.length === previousLength ? stable + 1 : 0;
        previousLength = result.markdown.length;
        if (stable >= 2) return { ok: true, ...result };
      }
    }
    await pause(500);
  }
  return { ok: false, error: "没有读到正文：帖子可能已删除、不可见，或页面没有加载完。" };
}
