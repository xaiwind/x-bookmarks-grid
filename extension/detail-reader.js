// Runs inside a temporary X tab. Only a verified main-post character count leaves the page.
export async function readPostLengthFromPage(expectedId) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const quoteSelector = '[data-testid="quoteTweet"], [data-testid="quoteTweetContainer"], [data-testid="quotedTweet"], article[data-testid="tweet"] article[data-testid="tweet"]';
  const isQuote = (node, post) => {
    if (node.closest?.(quoteSelector)) return true;
    const authors = [...(post?.querySelectorAll?.('[data-testid="User-Name"]') || [])];
    return authors.slice(1).some((author) => Boolean((author.compareDocumentPosition?.(node) || 0) & 4));
  };
  let previous = "";
  let stable = 0;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const rich = document.querySelector('[data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"]');
    const readView = rich?.closest?.('[data-testid="twitterArticleReadView"]');
    const articlePath = /^\/[^/]+\/article\/\d+(?:\/|$)/.test(location.pathname);
    const topLevelView = readView && typeof readView.closest === "function" && !readView.closest('article[data-testid="tweet"]') && !readView.closest(quoteSelector);
    let text = "";
    let isArticle = false;
    if (rich && (articlePath || topLevelView)) {
      const copy = rich.cloneNode(true);
      for (const node of copy.querySelectorAll(`${quoteSelector}, article[data-testid="tweet"]`)) node.remove();
      text = (copy.innerText || copy.textContent || "").trim();
      isArticle = true;
    } else if (attempt >= 4 && new RegExp(`/status/${expectedId}(?:/|$)`).test(location.pathname)) {
      const posts = [...document.querySelectorAll('article[data-testid="tweet"]')];
      const post = posts.find((item) => [...item.querySelectorAll('a[href*="/status/"]')].some((link) => !isQuote(link, item) && link.querySelector("time") && new RegExp(`/status/${expectedId}(?:/|$|\\?)`).test(link.getAttribute("href") || "")));
      if (post) {
        const main = [...post.querySelectorAll('[data-testid="tweetText"]')].find((node) => !isQuote(node, post));
        const collapsed = [...post.querySelectorAll('[data-testid="tweet-text-show-more-link"]')].some((node) => !isQuote(node, post));
        // A link to another article can be a quote. Never navigate to it on behalf of this post.
        const ambiguousArticle = [...post.querySelectorAll('a[href*="/article/"]')].some((node) => !isQuote(node, post));
        const ambiguousStatus = [...post.querySelectorAll('a[href*="/status/"]')].some((node) => {
          if (isQuote(node, post)) return false;
          const id = String(node.getAttribute?.("href") || node.href || "").match(/\/status\/(\d+)/)?.[1];
          return Boolean(id && id !== String(expectedId));
        });
        const ownArticleMarker = [...post.querySelectorAll('[data-testid="twitter-article-title"], [data-testid="twitterArticleReadView"]')].some((node) => !isQuote(node, post));
        if (main && !collapsed && !ambiguousArticle && !ambiguousStatus && !ownArticleMarker) text = (main.innerText || "").trim();
      }
    }
    if (text) {
      const count = [...text].length;
      const current = `${isArticle}:${count}`;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 2) return { ok: true, textLength: count, isArticle };
    }
    await pause(500);
  }
  return { ok: false, error: "主帖详情未加载完整或引用关系不明确，字数暂不可确认。" };
}

