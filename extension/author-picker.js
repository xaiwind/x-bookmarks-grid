import { filterAuthorOptions } from "../src/manager-core.js";
import { t, tr } from "../src/i18n.js";

const MAX_VISIBLE_OPTIONS = 150;
const BLUR_CLOSE_DELAY_MS = 120;

/**
 * Author filter with its own dropdown. Unlike a native datalist, opening it always shows every
 * author, so a different author can be picked without first deleting the current one.
 *
 * @param {object} params
 * @param {HTMLInputElement} params.input
 * @param {HTMLElement} params.list
 * @param {HTMLButtonElement} params.clearButton
 * @param {() => void} params.onChange called after the user picks or clears an author
 */
export function createAuthorPicker({ input, list, clearButton, onChange }) {
  let authors = [];
  let visible = [];
  let activeIndex = -1;
  // While false, the box still shows the previously chosen author and the list is unfiltered.
  let typed = false;
  // Handle of the author picked from the list or a card. The box shows that author's nickname,
  // so the handle is kept here; it is dropped as soon as the user types their own text.
  let selected = "";

  function displayText(author) {
    return authors.find((option) => option.author === author)?.name || author;
  }

  function render() {
    visible = filterAuthorOptions(authors, typed ? input.value : "", MAX_VISIBLE_OPTIONS);
    const current = (selected || input.value.trim().replace(/^@/, "")).toLowerCase();
    list.innerHTML = visible.length
      ? visible.map((option, index) => `<li class="author-option${index === activeIndex ? " active" : ""}" role="option" data-index="${index}" aria-selected="${option.author.toLowerCase() === current}">${authorLabel(option)}<small>${tr`${option.count} 条`}</small></li>`).join("")
      : `<li class="author-empty">${t("没有匹配的作者")}</li>`;
  }

  function open() {
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    render();
  }

  function close() {
    list.hidden = true;
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
  }

  function sync() {
    clearButton.hidden = !input.value;
  }

  function select(author) {
    selected = String(author || "");
    input.value = displayText(selected);
    typed = false;
    sync();
  }

  function choose(author) {
    select(author);
    close();
    onChange();
  }

  function move(step) {
    if (list.hidden) open();
    if (!visible.length) return;
    activeIndex = (activeIndex + step + visible.length) % visible.length;
    render();
    list.querySelector(".author-option.active")?.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("focus", () => {
    typed = false;
    input.select();
    open();
  });
  input.addEventListener("click", () => {
    if (list.hidden) open();
  });
  input.addEventListener("input", () => {
    typed = true;
    selected = "";
    activeIndex = -1;
    sync();
    open();
  });
  input.addEventListener("blur", () => setTimeout(close, BLUR_CLOSE_DELAY_MS));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && !list.hidden && visible[activeIndex]) {
      event.preventDefault();
      choose(visible[activeIndex].author);
    } else if (event.key === "Escape" && !list.hidden) {
      event.stopPropagation();
      close();
    }
  });
  // mousedown fires before the input loses focus, so the choice is not lost to the blur handler.
  list.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const option = visible[Number(event.target.closest("[data-index]")?.dataset.index)];
    if (option) choose(option.author);
  });
  clearButton.addEventListener("click", () => {
    choose("");
    input.focus();
  });

  return {
    /** @param {{ author: string, name?: string, count: number }[]} nextAuthors */
    setAuthors(nextAuthors) {
      authors = nextAuthors;
      if (selected) input.value = displayText(selected);
      if (!list.hidden) render();
    },
    /** The text to filter by: the picked author's handle, or whatever the user typed. */
    value: () => selected || input.value,
    /** Sets the author from outside (a card's author link, or "" to clear) without calling onChange. */
    select,
  };
}

// Nickname first with the handle underneath; authors whose nickname was never captured show the handle only.
export function authorLabel({ author, name = "" }) {
  const handle = `@${escapeText(author)}`;
  return name
    ? `<span class="author-names" title="${escapeText(name)} ${handle}"><span class="author-name">${escapeText(name)}</span><span class="author-handle">${handle}</span></span>`
    : `<span class="author-names" title="${handle}"><span class="author-name">${handle}</span></span>`;
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
