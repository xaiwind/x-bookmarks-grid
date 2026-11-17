import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../src/i18n.js";
import { setupLanguageToggle } from "../extension/language-toggle.js";

function fakeButton() {
  const attributes = {};
  const listeners = {};
  return {
    textContent: "", title: "", attributes, listeners,
    setAttribute: (name, value) => { attributes[name] = value; },
    addEventListener: (name, listener) => { listeners[name] = listener; },
  };
}

test("the switch is labelled with the language it changes to", () => {
  try {
    setLanguage("zh");
    const toEnglish = fakeButton();
    setupLanguageToggle(toEnglish);
    assert.deepEqual([toEnglish.textContent, toEnglish.title, toEnglish.attributes["aria-label"]], ["EN", "Switch to English", "Switch to English"]);
    setLanguage("en");
    const toChinese = fakeButton();
    setupLanguageToggle(toChinese);
    assert.deepEqual([toChinese.textContent, toChinese.title], ["中文", "切换到中文"]);
  } finally {
    setLanguage("zh");
  }
});

test("clicking saves the other language and reloads the page", async () => {
  const saved = [];
  let reloads = 0;
  const button = fakeButton();
  try {
    setLanguage("zh");
    setupLanguageToggle(button, { save: async (language) => { saved.push(language); }, reload: () => { reloads += 1; } });
    await button.listeners.click();
    assert.deepEqual(saved, ["en"]);
    assert.equal(reloads, 1);
  } finally {
    setLanguage("zh");
  }
});

test("a failed save is reported and the page is not reloaded", async () => {
  const errors = [];
  let reloads = 0;
  const button = fakeButton();
  setupLanguageToggle(button, { save: async () => { throw new Error("quota"); }, reload: () => { reloads += 1; }, onError: (error) => { errors.push(error.message); } });
  await button.listeners.click();
  assert.deepEqual(errors, ["quota"]);
  assert.equal(reloads, 0);
});

test("a page without the button is left alone", () => {
  assert.doesNotThrow(() => setupLanguageToggle(null));
});
