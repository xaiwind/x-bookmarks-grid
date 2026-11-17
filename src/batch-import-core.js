import { normalizeTweet } from "./core.js";

export function prepareImportBatch(tweets = []) {
  const seen = new Set();
  const records = [];
  for (const tweet of tweets) {
    if (!tweet?.id || seen.has(tweet.id)) continue;
    seen.add(tweet.id);
    records.push(normalizeTweet({
      ...tweet,
      text: "",
      imageUrls: (tweet.imageUrls || []).slice(0, 4),
      contentStatus: "url_only",
      syncStatus: "indexed",
    }));
  }
  return records;
}
