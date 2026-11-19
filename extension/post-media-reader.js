import { extractArticleLayout, extractPostMedia, findTweetResult } from "../src/post-media.js";

// Background helpers that find a post's photos and videos while the extension has the post open
// in a temporary tab for a download. post-hook.js is registered only for the duration of the read.

const HOOK_ID = "x-bookmark-post-media-hook";
const HOOK_MATCHES = ["https://x.com/*/status/*", "https://twitter.com/*/status/*", "https://x.com/*/article/*", "https://twitter.com/*/article/*"];
let hookUsers = 0;

/**
 * Runs `read` with post-hook.js active on post pages, so a tab opened inside it records post data.
 * When the hook cannot be registered the read still runs; the download then falls back to the
 * images saved during sync.
 * @template T
 * @param {() => Promise<T>} read
 * @returns {Promise<{ result: T, hooked: boolean }>}
 */
export async function withPostHook(read) {
  hookUsers += 1;
  const hooked = hookUsers > 1 || (await registerHook());
  try {
    return { result: await read(), hooked };
  } finally {
    hookUsers -= 1;
    if (!hookUsers) await chrome.scripting.unregisterContentScripts({ ids: [HOOK_ID] }).catch(() => {});
  }
}

async function registerHook() {
  try {
    await chrome.scripting.registerContentScripts([{ id: HOOK_ID, matches: HOOK_MATCHES, js: ["extension/post-hook.js"], runAt: "document_start", world: "MAIN", persistAcrossSessions: false }]);
    return true;
  } catch (error) {
    // Left over from a service worker that stopped mid-read: it is already active.
    return /duplicate/i.test(String(error?.message));
  }
}

/**
 * @param {number} tabId
 * @param {string} id post id
 * @returns {Promise<{ media: object[], layout: object[], views: string, error: string }>} layout places an article's
 *   inline media; views is the current view count, or ""
 */
export async function readCapturedMedia(tabId, id) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => (Array.isArray(window.__xBookmarkPostCaptures) ? window.__xBookmarkPostCaptures.slice() : []),
    });
    const texts = Array.isArray(injection?.result) ? injection.result : [];
    for (const text of texts.reverse()) {
      const result = findTweetResult(safeParse(text), id);
      if (result) return { media: extractPostMedia(result), layout: extractArticleLayout(result), views: readViews(result), error: "" };
    }
    return { media: [], layout: [], views: "", error: texts.length ? "post_not_in_data" : "no_data" };
  } catch (error) {
    return { media: [], layout: [], views: "", error: String(error?.message || error) };
  }
}

function readViews(result) {
  const count = String((result?.tweet || result)?.views?.count ?? "");
  return /^\d{1,15}$/.test(count) ? count : "";
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
