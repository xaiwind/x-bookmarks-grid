export function isBookmarkPageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname)) return false;
    return /^\/i\/(?:bookmarks(?:\/[^/]*)*|history(?:\/bookmarks(?:\/[^/]*)*)?)\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}
