import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/page-hook.js", import.meta.url), "utf8");
const TIMELINE = JSON.stringify({ data: { timeline: { instructions: [] } } });

function loadHook({ cookie = "ct0=fresh-token; other=1" } = {}) {
  const posted = [];
  const fetched = [];
  const listeners = {};
  class FakeXhr {
    constructor() { this.listeners = {}; this.status = 200; this.responseType = ""; this.responseText = ""; }
    open() {}
    setRequestHeader() {}
    send() {}
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }
  const window = {
    fetch: async (url, init) => { fetched.push({ url, init }); return { ok: true, status: 200, text: async () => TIMELINE, clone() { return this; } }; },
    postMessage: (message) => posted.push(message),
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const location = { origin: "https://x.com" };
  const context = vm.createContext({ window, location, document: { cookie }, XMLHttpRequest: FakeXhr, URL, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const send = (type, payload, id = "1") => listeners.message({ source: window, origin: location.origin, data: { channel: "x-bookmark-library", direction: "to-page", type, id, payload } });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const xhrRequest = (url, { method = "GET", headers = {}, body, response = TIMELINE, status = 200 } = {}) => {
    const xhr = new FakeXhr();
    xhr.open(method, url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.send(body);
    xhr.status = status;
    xhr.responseText = response;
    xhr.listeners.load?.();
  };
  return { posted, fetched, send, settle, xhrRequest, window, listeners };
}

const bookmarksUrl = (variables) => `/i/api/graphql/QID/Bookmarks?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent('{"f":true}')}`;

test("captures the page's own bookmark request and forwards the response", async () => {
  const hook = loadHook();
  hook.send("state");
  assert.deepEqual({ ...hook.posted.at(-1).payload }, { ok: true, ready: false });
  hook.xhrRequest("/i/api/graphql/QID/HomeTimeline?variables=%7B%7D");
  hook.xhrRequest("/i/api/graphql/QID/CreateBookmark", { method: "POST", body: "{}" });
  hook.xhrRequest("/i/api/graphql/QID/BookmarkFoldersSlice?variables=%7B%7D");
  hook.xhrRequest(bookmarksUrl({ count: 20 }), { status: 500 });
  assert.equal(hook.posted.filter((message) => message.type === "captured").length, 0);
  hook.xhrRequest(bookmarksUrl({ count: 20 }), { headers: { Authorization: "Bearer abc" } });
  assert.equal(hook.posted.at(-1).type, "captured");
  assert.equal(hook.posted.at(-1).text, TIMELINE);
  hook.send("state");
  assert.deepEqual({ ...hook.posted.at(-1).payload }, { ok: true, ready: true });
});

test("repeats the captured request with a new cursor, page size and the current csrf token", async () => {
  const hook = loadHook();
  hook.xhrRequest(bookmarksUrl({ count: 20, includePromotedContent: true, cursor: "old" }), { headers: { Authorization: "Bearer abc", "X-Csrf-Token": "stale" } });
  hook.send("fetch-page", { cursor: "NEXT", count: 100 }, "7");
  await hook.settle();
  const { url, init } = hook.fetched[0];
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://x.com/i/api/graphql/QID/Bookmarks");
  assert.deepEqual(JSON.parse(parsed.searchParams.get("variables")), { count: 100, includePromotedContent: true, cursor: "NEXT" });
  assert.equal(parsed.searchParams.get("features"), '{"f":true}');
  assert.deepEqual({ method: init.method, auth: init.headers.authorization, csrf: init.headers["x-csrf-token"], credentials: init.credentials }, { method: "GET", auth: "Bearer abc", csrf: "fresh-token", credentials: "include" });
  const reply = hook.posted.at(-1);
  assert.deepEqual({ id: reply.id, ok: reply.payload.ok, text: reply.payload.text }, { id: "7", ok: true, text: TIMELINE });
  hook.send("fetch-page", { cursor: "", count: 0 }, "8");
  await hook.settle();
  assert.deepEqual(JSON.parse(new URL(hook.fetched[1].url).searchParams.get("variables")), { count: 20, includePromotedContent: true });
  assert.equal(hook.posted.filter((message) => message.type === "captured").length, 1);
});

test("post requests keep their body and folder timelines never become the paging template", async () => {
  const hook = loadHook();
  hook.xhrRequest(bookmarksUrl({ count: 20, bookmark_collection_id: "5" }).replace("Bookmarks", "BookmarkFolderTimeline"));
  hook.send("fetch-page", { cursor: "", count: 100 });
  await hook.settle();
  assert.equal(hook.posted.at(-1).payload.error, "no_template");
  hook.xhrRequest("/i/api/graphql/QID/Bookmarks", { method: "POST", body: JSON.stringify({ queryId: "QID", features: { f: true }, variables: { count: 20 } }) });
  hook.send("fetch-page", { cursor: "C", count: 50 });
  await hook.settle();
  assert.deepEqual(JSON.parse(hook.fetched[0].init.body), { queryId: "QID", features: { f: true }, variables: { count: 50, cursor: "C" } });
});

test("the page's fetch calls are observed without changing their result and foreign messages are ignored", async () => {
  const hook = loadHook();
  const response = await hook.window.fetch("https://x.com" + bookmarksUrl({ count: 20 }), { headers: { authorization: "Bearer f" } });
  assert.equal(await response.text(), TIMELINE);
  await hook.settle();
  assert.equal(hook.posted.at(-1).type, "captured");
  const before = hook.posted.length;
  hook.listeners.message({ source: {}, origin: "https://evil.example", data: { channel: "x-bookmark-library", direction: "to-page", type: "state", id: "9" } });
  assert.equal(hook.posted.length, before);
});
