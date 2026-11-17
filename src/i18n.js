// Two-language support. Chinese is the source language: every user-facing string is written in
// Chinese where it is used, and English is looked up from a dictionary keyed by that string.
// A string without an English entry is shown in Chinese rather than failing.
import { EN } from "./i18n-en.js";

const SUPPORTED = ["zh", "en"];
let language = "zh";

/** @param {string} next "zh" or "en" */
export function setLanguage(next) {
  language = SUPPORTED.includes(next) ? next : "zh";
}

export function getLanguage() {
  return language;
}

/** Chinese for Chinese browsers, English for everything else. */
export function languageForLocale(locale) {
  return /^zh\b/i.test(String(locale || "")) ? "zh" : "en";
}

/** Storage key of the language the user picked with the switch button; absent means "follow the browser". */
export const LANGUAGE_PREFERENCE_KEY = "uiLanguage";

/** A saved choice wins; otherwise the browser's interface language decides. */
export function resolveLanguage(preference, locale) {
  return SUPPORTED.includes(preference) ? preference : languageForLocale(locale);
}

function readPagePreference() {
  try {
    return globalThis.localStorage?.getItem(LANGUAGE_PREFERENCE_KEY) ?? null;
  } catch {
    return null; // Storage blocked: fall back to the browser language.
  }
}

// The background service worker has no localStorage, so it reads the choice from
// chrome.storage and keeps following it while it runs.
function followStoredPreference() {
  const storage = globalThis.chrome?.storage;
  if (!storage?.local) return;
  Promise.resolve(storage.local.get(LANGUAGE_PREFERENCE_KEY))
    .then((result) => { if (SUPPORTED.includes(result?.[LANGUAGE_PREFERENCE_KEY])) setLanguage(result[LANGUAGE_PREFERENCE_KEY]); })
    .catch(() => {}); // Unreadable preference: keep the browser language.
  storage.onChanged?.addListener((changes, area) => {
    const next = changes?.[LANGUAGE_PREFERENCE_KEY]?.newValue;
    if (area === "local" && SUPPORTED.includes(next)) setLanguage(next);
  });
}

/** Picks the saved language, or the browser's interface language. Call once per extension context. */
export function initLanguage() {
  const locale = globalThis.chrome?.i18n?.getUILanguage?.() || globalThis.navigator?.language || "";
  setLanguage(resolveLanguage(readPagePreference(), locale));
  if (!globalThis.localStorage) followStoredPreference();
  return language;
}

/** The language the switch button changes to. */
export function nextLanguage() {
  return language === "en" ? "zh" : "en";
}

/** Remembers the chosen language for every extension page and for the background. */
export async function saveLanguagePreference(next) {
  if (!SUPPORTED.includes(next)) throw new Error(`Unsupported language: ${next}`);
  setLanguage(next);
  try {
    globalThis.localStorage?.setItem(LANGUAGE_PREFERENCE_KEY, next);
  } catch {
    // Page storage blocked: chrome.storage below still records the choice.
  }
  await globalThis.chrome?.storage?.local?.set({ [LANGUAGE_PREFERENCE_KEY]: next });
  return next;
}

/** Translates a fixed string. */
export function t(text) {
  return language === "en" ? EN[text] ?? text : text;
}

/**
 * Tagged template for strings with values: tr`已读取 ${count} 条`.
 * The dictionary key replaces each value with {0}, {1}…, so English can reorder them.
 */
export function tr(strings, ...values) {
  const key = templateKey(strings);
  const template = language === "en" ? EN[key] ?? key : key;
  return template.replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? ""));
}

export function templateKey(strings) {
  return strings.reduce((key, part, index) => `${key}${index ? `{${index - 1}}` : ""}${part}`, "");
}

const TRANSLATED_ATTRIBUTES = ["title", "placeholder", "aria-label"];

/** Translates the static text of a page in place. Does nothing in Chinese. */
export function localizeDocument(root = globalThis.document) {
  if (language !== "en" || !root) return;
  root.documentElement?.setAttribute("lang", "en");
  const walker = root.createTreeWalker(root.documentElement || root, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (text && EN[text] !== undefined) node.nodeValue = node.nodeValue.replace(text, EN[text]);
  }
  for (const element of root.querySelectorAll(TRANSLATED_ATTRIBUTES.map((name) => `[${name}]`).join(","))) {
    for (const name of TRANSLATED_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value && EN[value] !== undefined) element.setAttribute(name, EN[value]);
    }
  }
}
