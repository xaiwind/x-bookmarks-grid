// This file can be injected again into the same isolated world.
var MAX_URL_SCROLL_ATTEMPTS = 80;
var STALE_SCROLL_LIMIT = 5;
if (!window.__xBookmarkCollectorInstalled) {
  window.__xBookmarkCollectorInstalled = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING_X_BOOKMARK_COLLECTOR") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "COLLECT_X_BOOKMARKS") return false;

    collectTweets({
      limit: message.limit || 10,
      mode: message.mode || "content",
      postTypeFilter: message.postTypeFilter || "all",
      onlyIds: message.onlyIds || [],
      excludeIds: message.excludeIds || [],
      operationId: message.operationId || "",
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
  startPassiveBookmarkSync();
}

function startPassiveBookmarkSync() {
  if (typeof MutationObserver !== "function" || typeof window.addEventListener !== "function") return;
  const sent = new Map();
  let sentTotal = null;
  let timer = null;
  let inFlight = false;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (inFlight || !isBookmarkTimelineLocation() || isLikesTimeline()) return;
      const pending = [];
      for (const article of getTimelinePosts()) {
        const tweet = parseTweetArticle(article);
        if (!tweet?.id) continue;
        const fingerprint = JSON.stringify([tweet.title, tweet.imageUrls, tweet.postType, tweet.isArticle, tweet.articleUrl, tweet.textLength, tweet.hasVideo, tweet.views]);
        if (sent.get(tweet.id) !== fingerprint && !pending.some((item) => item.tweet.id === tweet.id)) pending.push({ tweet, fingerprint });
        if (pending.length >= 50) break;
      }
      const bookmarkTotal = extractBookmarkTotal();
      if ((!pending.length && (bookmarkTotal === null || bookmarkTotal === sentTotal)) || isLikesTimeline() || !isBookmarkTimelineLocation()) return;
      inFlight = true;
      try {
        const result = await chrome.runtime.sendMessage({ type: "SYNC_VISIBLE_BOOKMARKS", tweets: pending.map((item) => item.tweet), bookmarkTotal });
        if (result?.ok) {
          for (const item of pending) sent.set(item.tweet.id, item.fingerprint);
          sentTotal = bookmarkTotal;
        }
      } catch {} finally {
        inFlight = false;
      }
    }, 1800);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("popstate", schedule);
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.settings) { sent.clear(); sentTotal = null; schedule(); }
  });
  schedule();
}

function isBookmarkTimelineLocation() {
  const path = globalThis.location?.pathname || "";
  return /^\/i\/(?:bookmarks(?:\/[^/]*)*|history(?:\/bookmarks(?:\/[^/]*)*)?)\/?$/.test(path);
}

async function collectTweets({ limit, mode, postTypeFilter = "all", onlyIds = [], excludeIds = [], operationId = "" }) {
  if (isLikesTimeline()) throw new Error("当前打开的是点赞列表，请切换到书签后再同步。");
  if (!await waitForBookmarkTimeline()) throw new Error("未读取到 X 书签列表，请确认登录状态及页面加载情况。");
  const found = new Map();
  const requestedIds = new Set(onlyIds);
  const excludedIds = new Set(excludeIds);
  const bookmarkFolders = new Set();
  const maxAttempts = MAX_URL_SCROLL_ATTEMPTS;
  let staleScrolls = 0;
  let previousSize = 0;
  let attempts = 0;
  let reason = "max_scroll_attempts";
  let previousPosition = "";
  let stablePosition = 0;
  const observedIds = new Set();

  for (let attempt = 0; attempt < maxAttempts && found.size < limit; attempt += 1) {
    if (isLikesTimeline()) throw new Error("X 已切换到点赞列表，同步已暂停。");
    attempts = attempt + 1;
    for (const article of getTimelinePosts()) {
      const tweet = parseTweetArticle(article);
      if (tweet?.id) observedIds.add(tweet.id);
      if (tweet?.bookmarkFolder) bookmarkFolders.add(tweet.bookmarkFolder);
      if (tweet?.id && (!requestedIds.size || requestedIds.has(tweet.id)) && !excludedIds.has(tweet.id) && shouldIncludePostType(tweet, postTypeFilter) && !found.has(tweet.id)) {
        found.set(tweet.id, tweet);
        reportCollectionProgress(operationId, mode, found.size, limit, attempts);
      }
      if (found.size >= limit) break;
    }
    if (found.size >= limit) {
      reason = "limit_reached";
      break;
    }

    staleScrolls = found.size === previousSize ? staleScrolls + 1 : 0;
    previousSize = found.size;
    if (mode === "full_import") {
      const scroller = document.scrollingElement || document.documentElement;
      const atBottom = scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - 12;
      const position = `${scroller.scrollTop}:${scroller.scrollHeight}:${observedIds.size}`;
      stablePosition = position === previousPosition ? stablePosition + 1 : 0;
      previousPosition = position;
      if (stablePosition >= 8) {
        reason = atBottom ? "stalled_at_bottom" : "scroll_stalled";
        break;
      }
    } else if ((mode === "url_index" || mode === "auto_sync" || mode === "live" || requestedIds.size) && staleScrolls >= STALE_SCROLL_LIMIT) {
      reason = "no_new_items";
      break;
    }

    reportCollectionProgress(operationId, mode, found.size, limit, attempts);
    window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: "auto" });
    await delay(900 + Math.random() * 500);
  }
  return {
    tweets: [...found.values()].slice(0, limit),
    meta: {
      attempts,
      reason,
      found: found.size,
      limit,
      mode,
      bookmarkFolders: [...bookmarkFolders],
      bookmarkTotal: extractBookmarkTotal(),
    },
  };
}

function getTimelinePosts() {
  const primary = document.querySelector?.('[data-testid="primaryColumn"]');
  const scope = primary?.querySelectorAll ? primary : document;
  return [...scope.querySelectorAll('article[data-testid="tweet"]')]
    .filter((article) => !article.parentElement?.closest?.('article[data-testid="tweet"]'));
}

function extractBookmarkTotal() {
  const nodes = document.querySelectorAll('[role="tab"][aria-selected="true"], [role="tab"][aria-current="page"], main h1');
  for (const node of nodes) {
    for (const label of [node.getAttribute?.("aria-label"), node.textContent]) {
      const text = String(label || "").replace(/\s+/g, " ").trim();
      const match = text.match(/^(?:书签|收藏|bookmarks|saved)\s*[:：]?\s+([\d,]+)\s*(?:条|个)?$/i)
        || text.match(/^(?:共\s*)?([\d,]+)\s*(?:条|个)\s*(?:书签|收藏)$/i);
      if (!match) continue;
      const count = Number(match[1].replace(/,/g, ""));
      if (Number.isSafeInteger(count) && count >= 0) return count;
    }
  }
  return null;
}

function isLikesTimeline() {
  if (!/^\/i\/history(?:\/|$)/.test(globalThis.location?.pathname || "")) return false;
  if (/^\/i\/history\/likes(?:\/|$)/.test(location.pathname)) return true;
  const selected = [...document.querySelectorAll('[role="tab"][aria-selected="true"], [role="tab"][aria-current="page"]')];
  return selected.some((tab) => {
    const href = tab.getAttribute("href") || tab.closest?.("a[href]")?.getAttribute("href") || tab.querySelector?.("a[href]")?.getAttribute("href") || "";
    const label = `${tab.textContent || ""} ${tab.getAttribute("aria-label") || ""}`.trim();
    return /\/i\/history\/likes(?:\/|$)/.test(href) || /^(likes?\b|liked\b|喜欢|点赞|已点赞|赞过|いいね)/i.test(label);
  });
}

async function waitForBookmarkTimeline() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (document.querySelector('article[data-testid="tweet"]')) return true;
    if (!isLikesTimeline() && extractBookmarkTotal() === 0) return true;
    await delay(250);
  }
  return false;
}

function reportCollectionProgress(operationId, mode, found, limit, attempts) {
  if (!operationId) return;
  chrome.runtime.sendMessage({
    type: "BOOKMARK_IMPORT_PROGRESS",
    operationId,
    stage: mode === "url_index" ? "scanning_urls" : "scanning_content",
    scanned: found,
    total: limit,
    attempts,
  }).catch(() => {});
}

function parseTweetArticle(article) {
  const anchors = [...article.querySelectorAll('a[href*="/status/"]')].filter((anchor) => !isInsideQuote(anchor));
  const statusAnchor = (anchors.find((anchor) => anchor.querySelector?.("time")) || anchors[0])?.href;
  if (!statusAnchor) return null;

  const id = statusAnchor.match(/\/status\/(\d+)/)?.[1];
  const author = extractAuthor(statusAnchor, article);
  const title = extractTitle(article);
  const bookmarkFolder = extractBookmarkFolder();
  const text = extractTweetText(article);
  const isArticle = isNativeArticle(article);
  const articleUrl = extractArticleUrl(article);
  const ambiguousReference = hasAmbiguousReference(article, id);
  const textLength = ambiguousReference ? 0 : countCharacters(text);
  const textComplete = Boolean(text) && !ambiguousReference && !hasCollapsedText(article) && !hasUnresolvedCard(article);
  const postType = inferPostType(textLength, isArticle, textComplete);
  return {
    id,
    url: normalizeStatusUrl(statusAnchor),
    author,
    title,
    bookmarkFolder,
    postType,
    classificationVersion: 4,
    isArticle,
    articleUrl,
    textLength,
    hasVideo: hasVideo(article),
    imageUrls: extractImageUrls(article),
    externalUrls: extractExternalUrls(article, statusAnchor),
    views: extractViews(article),
    createdAt: article.querySelector("time")?.getAttribute("datetime") || "",
    syncedAt: new Date().toISOString(),
  };
}

function extractBookmarkFolder() {
  const heading = document.querySelector('main h1, [data-testid="primaryColumn"] h1');
  const text = heading?.textContent?.trim();
  if (text && !/Bookmarks|书签/.test(text)) return text;
  return "";
}

function extractTitle(article) {
  const text = extractTweetText(article).replace(/\s+/g, " ").trim();
  const cardTitle = extractCardTitle(article);
  const title = cardTitle || text || extractReadableLine(article);
  return title.replace(/\s+/g, " ").trim().slice(0, 90);
}

function extractCardTitle(article) {
  const card = article.querySelector('[data-testid="card.wrapper"], [data-testid="article"], [data-testid="card.layoutLarge.media"]');
  if (!card) return "";
  const lines = (card.innerText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => (
    !/^https?:\/\//i.test(line) &&
    !line.startsWith("@") &&
    !/^(From|来自|Ad|广告)$/i.test(line) &&
    !isFollowerCountLine(line) &&
    line.length > 4
  )) || "";
}

function extractReadableLine(article) {
  const lines = (article.innerText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => (
    !line.startsWith("@") &&
    !/^https?:\/\//i.test(line) &&
    !/^(Replying to|回复|关注|Follow|Ad|广告)$/i.test(line) &&
    !isFollowerCountLine(line) &&
    line.length > 6
  )) || "";
}

function isFollowerCountLine(line) {
  return /^[\d,.]+\s*[KMB万千亿]?\s*(位)?(粉丝|关注者|followers?|following|正在关注)$/i.test(String(line || "").trim());
}

function inferPostType(textLength = 0, isArticle = false, textComplete = false) {
  if (isArticle) return "unknown";
  if (textLength > 3000) return "long";
  return textComplete ? "short" : "unknown";
}

function countCharacters(value = "") {
  return [...String(value).trim()].length;
}

function isNativeArticle(article) {
  return [...article.querySelectorAll('[data-testid="article"], [data-testid="twitter-article-title"], [data-testid="twitterArticleReadView"], [data-testid="twitterArticleRichTextView"], a[href*="/article/"]')].some((anchor) => {
    if (isInsideQuote(anchor)) return false;
    if (anchor.matches('[data-testid="article"], [data-testid="twitter-article-title"], [data-testid="twitterArticleReadView"], [data-testid="twitterArticleRichTextView"]')) return true;
    try {
      const url = new URL(anchor.href);
      return (url.hostname === "x.com" || url.hostname === "twitter.com") && /\/article\//.test(url.pathname);
    } catch {
      return false;
    }
  });
}

function extractArticleUrl(article) {
  for (const anchor of article.querySelectorAll('a[href*="/article/"]')) {
    if (isInsideQuote(anchor)) continue;
    try {
      const url = new URL(anchor.href);
      const path = url.pathname.match(/^\/[^/]+\/article\/\d+/)?.[0];
      if ((url.hostname === "x.com" || url.hostname === "twitter.com") && path) return `https://x.com${path}`;
    } catch {}
  }
  return "";
}

function isInsideQuote(node) {
  if (node.closest('[data-testid="quoteTweet"], [data-testid="quoteTweetContainer"], [data-testid="quotedTweet"], article[data-testid="tweet"] article[data-testid="tweet"]')) return true;
  const post = node.closest('article[data-testid="tweet"]');
  const authors = [...(post?.querySelectorAll?.('[data-testid="User-Name"]') || [])];
  return authors.slice(1).some((author) => Boolean((author.compareDocumentPosition?.(node) || 0) & 4));
}

function hasCollapsedText(article) {
  return [...article.querySelectorAll('[data-testid="tweet-text-show-more-link"], a[href*="/status/"][href$="/more"]')].some((node) => !isInsideQuote(node));
}

function hasAmbiguousReference(article, primaryId) {
  return [...article.querySelectorAll('a[href*="/status/"]')].some((anchor) => {
    if (isInsideQuote(anchor)) return false;
    const otherId = String(anchor.href || "").match(/\/status\/(\d+)/)?.[1];
    return Boolean(otherId && otherId !== String(primaryId));
  });
}

function hasUnresolvedCard(article) {
  return [...article.querySelectorAll('[data-testid="card.wrapper"], [data-testid="card.layoutLarge"], [data-testid="card.layoutLarge.media"]')].some((node) => !isInsideQuote(node));
}

function hasVideo(article) {
  return Boolean(article.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]'));
}

function shouldIncludePostType(tweet, filter = "all") {
  if (!filter || filter === "all") return true;
  return (tweet.postType || "short") === filter;
}

function extractViews(article) {
  const candidates = [
    ...article.querySelectorAll('a[href$="/analytics"], [aria-label*="views"], [aria-label*="Views"], [aria-label*="浏览"], [aria-label*="查看"]'),
  ];
  for (const node of candidates) {
    const label = node.getAttribute("aria-label") || node.textContent || "";
    const match = label.match(/([\d,.]+[KMB万千亿]?)[^\d]*(views|Views|浏览|查看)/);
    if (match) return match[1];
  }
  return "";
}

function extractAuthor(statusUrl, article) {
  try {
    const pathname = new URL(statusUrl).pathname;
    const fromUrl = pathname.split("/").filter(Boolean)[0];
    if (fromUrl) return fromUrl;
  } catch {}
  const text = article.innerText.match(/@([A-Za-z0-9_]+)/)?.[1];
  return text || "unknown";
}

function extractTweetText(article) {
  const mainText = [...article.querySelectorAll('[data-testid="tweetText"]')].find((node) => !isInsideQuote(node));
  return mainText?.innerText?.trim() || "";
}

function extractImageUrls(article) {
  const candidates = [];
  const quotedCandidates = [];
  const add = (node, ...urls) => (isInsideQuote(node) ? quotedCandidates : candidates).push(...urls);
  for (const image of article.querySelectorAll("img")) {
    add(image,
      image.currentSrc,
      image.src,
      image.getAttribute("data-src"),
      image.getAttribute("data-image-url"),
      image.getAttribute("data-original"),
    );
    const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
    add(image, ...srcset.split(",").map((candidate) => candidate.trim().split(/\s+/)[0]));
  }
  for (const video of article.querySelectorAll("video[poster]")) add(video, video.poster);
  for (const element of article.querySelectorAll('[style*="background-image"]')) {
    const background = getComputedStyle(element).backgroundImage || element.style.backgroundImage || "";
    add(element, ...[...background.matchAll(/url\(["']?(.*?)["']?\)/g)].map((match) => match[1]));
  }
  const articleMediaElements = article.querySelectorAll('[data-testid="article"], [data-testid="card.wrapper"], [data-testid*="media"], [data-testid*="photo"], a[href*="/article/"][href*="/media/"]');
  for (const element of articleMediaElements) {
    const nodes = [element, ...element.querySelectorAll("*")];
    for (const node of nodes) {
      add(node, ...getBackgroundImages(node));
    }
    if (element.matches('a[href*="/article/"][href*="/media/"]')) {
      for (let parent = element.parentElement; parent && parent !== article; parent = parent.parentElement) {
        add(parent, ...getBackgroundImages(parent));
      }
    }
  }

  const urls = [...candidates, ...quotedCandidates].map((value) => {
    try {
      const url = new URL(value, location.href);
      if (url.hostname !== "pbs.twimg.com") return "";
      if (/\/(profile_images|profile_banners|emoji)\//.test(url.pathname)) return "";
      if (!/\/(media|card_img|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(url.pathname)) return "";
      return cleanImageUrl(url.href);
    } catch {
      return "";
    }
  }).filter(Boolean);
  return [...new Set(urls)];
}

function getBackgroundImages(element) {
  const layers = [
    getComputedStyle(element).backgroundImage,
    getComputedStyle(element, "::before").backgroundImage,
    getComputedStyle(element, "::after").backgroundImage,
  ];
  return layers.flatMap((background) => [...background.matchAll(/url\(["']?(.*?)["']?\)/g)].map((match) => match[1]));
}

function extractExternalUrls(article, statusAnchor) {
  const statusUrl = normalizeStatusUrl(statusAnchor);
  const urls = [...article.querySelectorAll("a[href]")]
    .map((anchor) => anchor.href)
    .filter((href) => href && !href.includes("/status/") && !href.includes("/photo/"))
    .filter((href) => !href.startsWith("https://x.com/") && !href.startsWith("https://twitter.com/"))
    .filter((href) => href !== statusUrl);
  return [...new Set(urls)];
}

function normalizeStatusUrl(url) {
  const parsed = new URL(url);
  return `https://x.com${parsed.pathname.match(/^\/[^/]+\/status\/\d+/)?.[0] || parsed.pathname}`;
}

function cleanImageUrl(url) {
  const parsed = new URL(url);
  if (!/\/(media|card_img)\//.test(parsed.pathname)) return parsed.toString();
  const format = parsed.searchParams.get("format");
  parsed.search = "";
  if (format) parsed.searchParams.set("format", format);
  parsed.searchParams.set("name", "large");
  return parsed.toString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
