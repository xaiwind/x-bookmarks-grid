// Runs in the page's own JavaScript world, and is registered only while the extension reads a
// post the user asked to download (see readPostMarkdown in background.js). It keeps the post data
// X's web client loads for that page, so the extension can find the post's photos and videos.
// Nothing is sent anywhere; the extension reads the kept responses from this tab and closes it.
(() => {
  if (window.__xBookmarkPostHook) return;
  window.__xBookmarkPostHook = true;

  const MAX_KEPT = 12;
  const MAX_LENGTH = 8_000_000;
  const kept = [];
  Object.defineProperty(window, "__xBookmarkPostCaptures", { value: kept, configurable: false, enumerable: false });

  const isGraphql = (url) => {
    try {
      return /^\/i\/api\/graphql\//.test(new URL(String(url), location.origin).pathname);
    } catch {
      return false;
    }
  };
  const keep = (text) => {
    if (typeof text !== "string" || text.length > MAX_LENGTH || !text.includes('"rest_id"')) return;
    kept.push(text);
    if (kept.length > MAX_KEPT) kept.shift();
  };

  try {
    const proto = XMLHttpRequest.prototype;
    const nativeOpen = proto.open;
    proto.open = function (method, url) {
      if (isGraphql(url)) {
        this.addEventListener("load", () => {
          try {
            if (this.status !== 200) return;
            keep(this.responseType === "" || this.responseType === "text" ? this.responseText : JSON.stringify(this.response));
          } catch {}
        });
      }
      return nativeOpen.apply(this, arguments);
    };
  } catch {}

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input) {
      const promise = nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url || String(input);
        if (isGraphql(url)) promise.then((response) => (response.ok ? response.clone().text().then(keep) : null)).catch(() => {});
      } catch {}
      return promise;
    };
  }
})();
