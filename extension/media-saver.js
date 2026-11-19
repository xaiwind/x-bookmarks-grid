import { mediaKey, planLocalMedia, rewriteMediaLinks, videoPosterPairs } from "../src/post-media.js";
import { writeStreamFile } from "./folder-files.js";

// Saves the photos and videos a downloaded note links to into an assets folder beside it, and
// points the note at the local files. Anything that cannot be saved keeps its web link.

const IMAGE_TIMEOUT_MS = 60_000;
const VIDEO_TIMEOUT_MS = 15 * 60_000;

/**
 * @param {object} params
 * @param {FileSystemDirectoryHandle} params.folder the chosen download folder
 * @param {string} params.notePath note path relative to that folder
 * @param {string} params.markdown
 * @param {string} params.id post id
 * @param {(done: number, total: number) => void} [params.onProgress]
 * @returns {Promise<{ markdown: string, saved: number, failed: { url: string, reason: string }[] }>}
 */
export async function saveLinkedMedia({ folder, notePath, markdown, id, onProgress = () => {} }) {
  const base = notePath.split("/").slice(0, -1);
  const posters = videoPosterPairs(markdown);
  // Videos first: a poster is only needed when its video could not be saved.
  const plan = planLocalMedia(markdown, { id }).sort((a, b) => Number(b.kind === "video") - Number(a.kind === "video"));
  const saved = new Map();
  const failed = [];
  const needed = (item) => !(posters.has(mediaKey(item.url)) && saved.has(posters.get(mediaKey(item.url))));
  let done = 0;
  for (const item of plan) {
    if (!needed(item)) continue;
    onProgress(done + 1, plan.length);
    try {
      await download(item.url, folder, [...base, item.file].join("/"), item.kind);
      saved.set(mediaKey(item.url), item.file);
    } catch (failure) {
      failed.push({ url: item.url, reason: failure?.name === "AbortError" ? "timeout" : String(failure?.message || failure) });
    }
    done += 1;
  }
  return { markdown: rewriteMediaLinks(markdown, saved), saved: saved.size, failed };
}

async function download(url, folder, path, kind) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), kind === "video" ? VIDEO_TIMEOUT_MS : IMAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await writeStreamFile(folder, path, response.body);
  } finally {
    clearTimeout(timer);
  }
}
