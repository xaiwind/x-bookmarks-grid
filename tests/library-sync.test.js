import test from "node:test";
import assert from "node:assert/strict";
import { syncBookmarkTimeline } from "../src/library-sync.js";

const pageText = (ids, cursor) => JSON.stringify({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ entries: [
  ...ids.map((id) => ({ entryId: `tweet-${id}`, sortIndex: String(1000 - Number(id)), content: { itemContent: { tweet_results: { result: { rest_id: String(id), core: { user_results: { result: { legacy: { screen_name: "user" } } } }, legacy: { full_text: `post ${id}` } } } } } })),
  ...(cursor ? [{ entryId: "cursor-bottom", content: { cursorType: "Bottom", value: cursor } }] : []),
] }] } } } });

function harness(responses, known = []) {
  const stored = new Map(known.map((id) => [String(id), { id: String(id) }]));
  const requests = [];
  const waits = [];
  const progress = [];
  return {
    stored, requests, waits, progress,
    deps: {
      fetchPage: async (request) => { requests.push(request); const next = responses.shift(); if (next instanceof Error) throw next; return next || { ok: false, status: 0, error: "no more responses" }; },
      saveRecords: async (records) => {
        const added = records.filter((record) => !stored.has(record.id)).length;
        for (const record of records) stored.set(record.id, record);
        return { added, updated: records.length - added };
      },
      wait: async (ms, reason) => { waits.push(reason); },
      onProgress: (update) => { progress.push(update); },
    },
  };
}

test("a full sync follows cursors to the end and saves every page as it arrives", async () => {
  const h = harness([
    { ok: true, text: pageText([1, 2], "c1") },
    { ok: true, text: pageText([3, 4], "c2") },
    { ok: true, text: pageText([], "c3") },
  ]);
  const result = await syncBookmarkTimeline({ ...h.deps, mode: "full" });
  const { trace, ...summary } = result;
  assert.deepEqual(summary, { outcome: "completed", pages: 3, scanned: 4, added: 4, updated: 0, error: "" });
  assert.deepEqual(trace.at(-1), { tweets: 0, fresh: 0, hasCursor: true, sameCursor: false });
  assert.deepEqual(h.requests, [{ cursor: "", count: 0 }, { cursor: "c1", count: 0 }, { cursor: "c2", count: 0 }]);
  assert.deepEqual([...h.stored.keys()], ["1", "2", "3", "4"]);
  assert.equal(h.stored.get("1").dataSource, "api");
  assert.equal(h.progress.at(-1).scanned, 4);
});

test("a full sync keeps going through already known pages", async () => {
  const h = harness([{ ok: true, text: pageText([1, 2], "c1") }, { ok: true, text: pageText([3], "") }], [1, 2]);
  const result = await syncBookmarkTimeline({ ...h.deps, mode: "full" });
  assert.deepEqual({ outcome: result.outcome, added: result.added, updated: result.updated }, { outcome: "completed", added: 1, updated: 2 });
});

test("an incremental sync stops at the first page that contains nothing new", async () => {
  const h = harness([{ ok: true, text: pageText([9, 1], "c1") }, { ok: true, text: pageText([2, 3], "c2") }, { ok: true, text: pageText([4], "c3") }], [1, 2, 3, 4]);
  const result = await syncBookmarkTimeline({ ...h.deps, mode: "incremental" });
  assert.deepEqual({ outcome: result.outcome, pages: result.pages, added: result.added }, { outcome: "caught_up", pages: 2, added: 1 });
  assert.equal(h.requests.length, 2);
});

test("paging that stops advancing is reported as stalled, never as the end of the list", async () => {
  const sameCursor = harness([{ ok: true, text: pageText([1], "c1") }, { ok: true, text: pageText([2], "c1") }]);
  assert.equal((await syncBookmarkTimeline({ ...sameCursor.deps, mode: "full" })).outcome, "stalled");
  assert.equal(sameCursor.requests.length, 2);
  const sameItems = harness([{ ok: true, text: pageText([1], "c1") }, { ok: true, text: pageText([1], "c2") }]);
  const repeated = await syncBookmarkTimeline({ ...sameItems.deps, mode: "full" });
  assert.equal(repeated.outcome, "stalled");
  assert.deepEqual(repeated.trace, [{ tweets: 1, fresh: 1, hasCursor: true, sameCursor: false }, { tweets: 1, fresh: 0, hasCursor: true, sameCursor: false }]);
  const noCursor = harness([{ ok: true, text: pageText([1, 2], "") }]);
  assert.equal((await syncBookmarkTimeline({ ...noCursor.deps, mode: "full" })).outcome, "completed");
});

test("a rejected first request retries with the page's own size, then reports the api as unavailable", async () => {
  const recovered = harness([{ ok: false, status: 400 }, { ok: true, text: pageText([1], "") }]);
  const ok = await syncBookmarkTimeline({ ...recovered.deps, mode: "full", options: { pageSize: 100 } });
  assert.equal(ok.outcome, "completed");
  assert.deepEqual(recovered.requests, [{ cursor: "", count: 100 }, { cursor: "", count: 0 }]);
  const broken = harness([{ ok: false, status: 404 }, { ok: false, status: 404 }]);
  const failed = await syncBookmarkTimeline({ ...broken.deps, mode: "full", options: { pageSize: 100 } });
  assert.equal(failed.outcome, "unavailable");
  assert.equal(broken.stored.size, 0);
});

test("unrecognised data on the first page is unavailable, later failures keep what was saved", async () => {
  const garbage = harness([{ ok: true, text: "<html>" }, { ok: true, text: JSON.stringify({ errors: [] }) }]);
  assert.equal((await syncBookmarkTimeline({ ...garbage.deps, mode: "full" })).outcome, "unavailable");
  const midway = harness([{ ok: true, text: pageText([1, 2], "c1") }, { ok: false, status: 403, error: "forbidden" }]);
  const result = await syncBookmarkTimeline({ ...midway.deps, mode: "full" });
  assert.deepEqual({ outcome: result.outcome, scanned: result.scanned, error: result.error }, { outcome: "failed", scanned: 2, error: "X 返回了错误（403）。" });
  assert.equal(midway.stored.size, 2);
});

test("rate limits and transient errors wait and retry before giving up", async () => {
  const h = harness([{ ok: true, text: pageText([1], "c1") }, { ok: false, status: 429 }, new Error("port closed"), { ok: false, status: 503 }, { ok: true, text: pageText([2], "") }]);
  const result = await syncBookmarkTimeline({ ...h.deps, mode: "full" });
  assert.equal(result.outcome, "completed");
  assert.deepEqual(h.waits, ["pace", "rate_limit", "retry", "retry"]);
  assert.ok(h.progress.some((update) => update.phase === "rate_limited"));
  const limited = harness([{ ok: true, text: pageText([1], "c1") }, { ok: false, status: 429 }, { ok: false, status: 429 }]);
  const stopped = await syncBookmarkTimeline({ ...limited.deps, mode: "full", options: { rateLimitRetries: 1 } });
  assert.equal(stopped.outcome, "failed");
  assert.match(stopped.error, /频率/);
});

test("cancelling stops before the next request and the page limit is reported", async () => {
  const h = harness([{ ok: true, text: pageText([1], "c1") }, { ok: true, text: pageText([2], "c2") }]);
  let checks = 0;
  const cancelled = await syncBookmarkTimeline({ ...h.deps, mode: "full", isCancelled: () => (checks += 1) > 1 });
  assert.deepEqual({ outcome: cancelled.outcome, scanned: cancelled.scanned }, { outcome: "cancelled", scanned: 1 });
  const capped = harness([{ ok: true, text: pageText([1], "c1") }, { ok: true, text: pageText([2], "c2") }]);
  assert.equal((await syncBookmarkTimeline({ ...capped.deps, mode: "full", options: { maxPages: 2 } })).outcome, "page_limit");
});

test("an incremental sync keeps reading while pages contain re-bookmarked posts that were already stored", async () => {
  const h = harness([{ ok: true, text: pageText([1, 2], "c1") }, { ok: true, text: pageText([3, 4], "c2") }, { ok: true, text: pageText([5, 6], "c3") }], [1, 2, 3, 4, 5, 6]);
  const refreshedPages = [2, 1, 0];
  const save = h.deps.saveRecords;
  const result = await syncBookmarkTimeline({ ...h.deps, mode: "incremental", saveRecords: async (records) => ({ ...(await save(records)), refreshed: refreshedPages.shift() }) });
  assert.deepEqual({ outcome: result.outcome, pages: result.pages, added: result.added }, { outcome: "caught_up", pages: 3, added: 0 });
  assert.equal(h.stored.size, 6);
});
