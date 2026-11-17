// Language switch button shared by the manager page and the popup.
import { nextLanguage, saveLanguagePreference } from "../src/i18n.js";

// Labelled in the language it switches to, so it is readable whichever language is showing.
const LANGUAGE_SWITCH = {
  en: { label: "EN", hint: "Switch to English" },
  zh: { label: "中文", hint: "切换到中文" },
};

/**
 * @param {HTMLElement | null} button
 * @param {{ save?: (language: string) => Promise<unknown>, reload?: () => void, onError?: (error: Error) => void }} [options]
 */
export function setupLanguageToggle(button, { save = saveLanguagePreference, reload = () => globalThis.location.reload(), onError = () => {} } = {}) {
  if (!button) return;
  const target = LANGUAGE_SWITCH[nextLanguage()];
  button.textContent = target.label;
  button.title = target.hint;
  button.setAttribute("aria-label", target.hint);
  button.addEventListener("click", async () => {
    try {
      await save(nextLanguage());
      reload(); // Static page text is translated once at load, so a reload applies the change everywhere.
    } catch (error) {
      onError(error);
    }
  });
}
