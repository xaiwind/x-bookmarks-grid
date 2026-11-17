// Runs inside a temporary X tab. Returns a short title and cover links for the expected post,
// never its body. A post that only contains media is reported as untitled rather than as a failure.
export async function readPostTitleFromPage(expectedId) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
  const quoteSelector = '[data-testid="quoteTweet"], [data-testid="quoteTweetContainer"], [data-testid="quotedTweet"], article[data-testid="tweet"] article[data-testid="tweet"]';
  const idPattern = new RegExp(`/(?:status|article)/${expectedId}(?:[/?#]|$)`);
  const isMainPost = (post) => [...post.querySelectorAll('a[href*="/status/"]')].some((link) => !link.closest(quoteSelector) && link.querySelector("time") && idPattern.test(link.getAttribute("href") || ""));
  const coversOf = (post) => [...(post.querySelectorAll("img") || [])]
    .filter((image) => !image.closest?.(quoteSelector))
    .map((image) => String(image.currentSrc || image.src || ""))
    .filter((src) => /^https:\/\/pbs\.twimg\.com\/(media|card_img|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(src))
    .slice(0, 4);
  const UNTITLED_AFTER_ATTEMPTS = 12;
  const TAB_TITLE_AFTER_ATTEMPTS = 8;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (idPattern.test(location.pathname)) {
      const posts = [...document.querySelectorAll('article[data-testid="tweet"]')];
      const post = posts.find(isMainPost) || (/\/article\//.test(location.pathname) ? document : null);
      if (post) {
        const articleTitle = [...post.querySelectorAll('[data-testid="twitter-article-title"]')].find((node) => !node.closest(quoteSelector));
        const text = [...post.querySelectorAll('[data-testid="tweetText"]')].find((node) => !node.closest(quoteSelector));
        const title = clean(articleTitle?.innerText || articleTitle?.textContent) || clean(text?.innerText || text?.textContent);
        if (title) return { ok: true, title, untitled: false, imageUrls: coversOf(post) };
      }
      // X puts the post text in the tab title: Name on X: "text" / X
      const fromTabTitle = attempt >= TAB_TITLE_AFTER_ATTEMPTS ? clean(document.title.match(/[:：]\s*["“](.+)["”]\s*\/\s*X\s*$/s)?.[1]) : "";
      if (fromTabTitle) return { ok: true, title: fromTabTitle, untitled: false, imageUrls: post ? coversOf(post) : [] };
      // The post is on screen and still has no text: it is a media-only post.
      if (post && post !== document && attempt >= UNTITLED_AFTER_ATTEMPTS) return { ok: true, title: "", untitled: true, imageUrls: coversOf(post) };
    }
    await pause(500);
  }
  return { ok: false, error: "帖子已删除、不可见，或页面没有加载出来。" };
}
