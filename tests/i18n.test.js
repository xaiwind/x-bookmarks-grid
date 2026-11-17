import test from "node:test";
import assert from "node:assert/strict";
import { EN } from "../src/i18n-en.js";
import { getLanguage, initLanguage, LANGUAGE_PREFERENCE_KEY, languageForLocale, nextLanguage, resolveLanguage, saveLanguagePreference, setLanguage, t, templateKey, tr } from "../src/i18n.js";
import { collectKeys } from "../scripts/list-i18n-keys.js";
import { displayTitle } from "../src/core.js";
import { formatCompactCount, describeBookmarkCounts } from "../src/manager-core.js";
import { buildPostMarkdown } from "../src/post-export.js";

test("every string shown to users has an English translation", () => {
  const missing = collectKeys().filter((key) => EN[key] === undefined);
  assert.deepEqual(missing, []);
});

test("translations keep every placeholder of their source string", () => {
  for (const [source, english] of Object.entries(EN)) {
    const placeholders = (text) => [...text.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
    assert.deepEqual(placeholders(english), placeholders(source), source);
    assert.ok(english.trim().length > 0 || source.trim().length === 0, source);
  }
});

test("Chinese browsers get Chinese and every other locale gets English", () => {
  assert.deepEqual(["zh-CN", "zh-TW", "zh", "en-US", "ja", "", undefined].map(languageForLocale), ["zh", "zh", "zh", "en", "en", "en", "en"]);
});

test("strings are translated only in English mode and unknown strings fall back to the source", () => {
  try {
    assert.equal(getLanguage(), "zh");
    assert.equal(t("清除筛选"), "清除筛选");
    assert.equal(tr`已同步：${"标题"}`, "已同步：标题");
    setLanguage("en");
    assert.equal(t("清除筛选"), "Clear filters");
    assert.equal(tr`已同步：${"My title"}`, "Synced: My title");
    assert.equal(tr`正在读取收藏：已读取 ${40} 条，新增 ${3} 条。`, "Reading bookmarks: 40 read, 3 new.");
    assert.equal(t("没有翻译的句子"), "没有翻译的句子");
    assert.equal(tr`没有翻译 ${1} 的模板`, "没有翻译 1 的模板");
    assert.equal(templateKey(["a", "b", "c"]), "a{0}b{1}c");
    setLanguage("fr");
    assert.equal(getLanguage(), "zh");
  } finally {
    setLanguage("zh");
  }
});

test("shared helpers produce English output in English mode", () => {
  try {
    setLanguage("en");
    assert.equal(displayTitle({ author: "bob", title: "", untitled: true, imageUrls: ["a"] }), "Image post by @bob (no text)");
    assert.equal(displayTitle({ author: "bob", title: "1876 粉丝", isArticle: true }), "Article by @bob (no title yet)");
    assert.deepEqual(["2500000", "12345", "999", ""].map(formatCompactCount), ["2.5M", "12.3K", "999", ""]);
    assert.match(describeBookmarkCounts({ sourceTotal: 20, syncedTotal: 2, scannedCount: 10 }), /Sync again to continue\. 10 read this time\./);
    const markdown = buildPostMarkdown({ id: "1", author: "bob", url: "https://x.com/bob/status/1", note: "keep" }, { exportedAt: new Date("2026-01-01T00:00:00Z") });
    assert.match(markdown, /^# Post by @bob$/m);
    assert.match(markdown, /> Source: https:\/\/x\.com\/bob\/status\/1 · Author: @bob/);
    assert.match(markdown, /## Notes\n\nkeep/);
  } finally {
    setLanguage("zh");
  }
});

function withGlobals(globals, run) {
  const saved = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const restore = () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    setLanguage("zh");
  };
  let result;
  try { result = run(); } catch (error) { restore(); throw error; }
  return Promise.resolve(result).finally(restore);
}

function fakeLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => (values.has(key) ? values.get(key) : null), setItem: (key, value) => { values.set(key, String(value)); }, values };
}

function fakeChrome({ locale = "en-US", stored = {} } = {}) {
  const listeners = [];
  const state = { ...stored };
  return {
    state, listeners,
    i18n: { getUILanguage: () => locale },
    storage: {
      local: {
        get: async (key) => ({ [key]: state[key] }),
        set: async (values) => { Object.assign(state, values); },
      },
      onChanged: { addListener: (listener) => { listeners.push(listener); } },
    },
  };
}

test("a saved language choice wins over the browser language", () => {
  assert.equal(resolveLanguage("en", "zh-CN"), "en");
  assert.equal(resolveLanguage("zh", "en-US"), "zh");
  assert.equal(resolveLanguage(null, "en-US"), "en");
  assert.equal(resolveLanguage("fr", "zh-CN"), "zh");
});

test("pages start in the saved language and fall back to the browser language", async () => {
  await withGlobals({ localStorage: fakeLocalStorage({ [LANGUAGE_PREFERENCE_KEY]: "zh" }), chrome: fakeChrome({ locale: "en-US" }) }, () => {
    assert.equal(initLanguage(), "zh");
  });
  await withGlobals({ localStorage: fakeLocalStorage(), chrome: fakeChrome({ locale: "en-US" }) }, () => {
    assert.equal(initLanguage(), "en");
  });
  await withGlobals({ localStorage: { getItem() { throw new Error("blocked"); } }, chrome: fakeChrome({ locale: "zh-CN" }) }, () => {
    assert.equal(initLanguage(), "zh");
  });
});

test("switching language is remembered for pages and for the background", async () => {
  const localStorage = fakeLocalStorage();
  const chrome = fakeChrome({ locale: "zh-CN" });
  await withGlobals({ localStorage, chrome }, async () => {
    initLanguage();
    assert.equal(nextLanguage(), "en");
    assert.equal(await saveLanguagePreference(nextLanguage()), "en");
    assert.equal(getLanguage(), "en");
    assert.equal(localStorage.values.get(LANGUAGE_PREFERENCE_KEY), "en");
    assert.equal(chrome.state[LANGUAGE_PREFERENCE_KEY], "en");
    assert.equal(nextLanguage(), "zh");
    await assert.rejects(() => saveLanguagePreference("fr"), /Unsupported language/);
  });
});

test("the background follows the saved choice, including later changes", async () => {
  const chrome = fakeChrome({ locale: "zh-CN", stored: { [LANGUAGE_PREFERENCE_KEY]: "en" } });
  await withGlobals({ localStorage: undefined, chrome }, async () => {
    assert.equal(initLanguage(), "zh");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getLanguage(), "en");
    chrome.listeners[0]({ [LANGUAGE_PREFERENCE_KEY]: { newValue: "zh" } }, "local");
    assert.equal(getLanguage(), "zh");
    chrome.listeners[0]({ [LANGUAGE_PREFERENCE_KEY]: { newValue: "en" } }, "sync");
    assert.equal(getLanguage(), "zh");
    chrome.listeners[0]({ settings: { newValue: {} } }, "local");
    assert.equal(getLanguage(), "zh");
  });
});
