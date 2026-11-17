// Content script (isolated world) that relays between the extension and page-hook.js.
// This file can be injected again into the same isolated world.
if (!window.__xBookmarkBridgeInstalled && typeof window.addEventListener === "function") {
  window.__xBookmarkBridgeInstalled = true;
  (() => {
    const CHANNEL = "x-bookmark-library";
    const REPLY_TIMEOUT_MS = 45_000;
    const STATE_TIMEOUT_MS = 2000;
    const MAX_CAPTURE_LENGTH = 8_000_000;
    const BOOKMARK_PATH = /^\/i\/(?:bookmarks(?:\/[^/]*)*|history(?:\/bookmarks(?:\/[^/]*)*)?)\/?$/;
    const pending = new Map();
    let nextId = 1;

    function askPage(type, payload, timeoutMs = REPLY_TIMEOUT_MS) {
      return new Promise((resolve) => {
        const id = `${Date.now()}-${nextId}`;
        nextId += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, status: 0, error: "X 页面没有响应。" });
        }, timeoutMs);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(reply && typeof reply === "object" ? reply : { ok: false, status: 0, error: "X 页面返回了无效数据。" });
        });
        window.postMessage({ channel: CHANNEL, direction: "to-page", type, id, payload }, location.origin);
      });
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (event.source !== window || event.origin !== location.origin || message?.channel !== CHANNEL || message.direction !== "to-extension") return;
      if (message.type === "reply") {
        pending.get(message.id)?.(message.payload);
        return;
      }
      if (message.type !== "captured" || typeof message.text !== "string" || message.text.length > MAX_CAPTURE_LENGTH) return;
      if (!BOOKMARK_PATH.test(location.pathname)) return;
      chrome.runtime.sendMessage({ type: "SAVE_CAPTURED_BOOKMARK_PAGE", text: message.text }).catch(() => {});
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "GET_BOOKMARK_API_STATE") {
        askPage("state", null, STATE_TIMEOUT_MS).then((state) => sendResponse({ ok: true, ready: Boolean(state?.ready), path: location.pathname }));
        return true;
      }
      if (message?.type === "FETCH_BOOKMARK_API_PAGE") {
        const cursor = typeof message.cursor === "string" ? message.cursor : "";
        const count = Number.isInteger(message.count) ? message.count : 0;
        askPage("fetch-page", { cursor, count }).then(sendResponse);
        return true;
      }
      return false;
    });
  })();
}
