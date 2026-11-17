import { t, tr } from "../src/i18n.js";

// Right-click menu, edit dialog and undo toast for bookmark cards.

const MENU_ITEMS = [
  { action: "open", label: "打开文章", hint: "在新标签页打开原帖" },
  { action: "sync", label: "同步文章", hint: "访问原帖，更新标题和封面" },
  { action: "edit", label: "编辑文章", hint: "修改标题、添加备注" },
  { action: "download", label: "下载文章", hint: "保存为 Markdown 文件" },
  { action: "delete", label: "删除文章", hint: "从插件里移除，X 上不受影响", danger: true },
];
const MENU_MARGIN = 8;
const TOAST_DURATION_MS = 7000;

/**
 * @param {object} params
 * @param {HTMLElement} params.menu empty container for the menu
 * @param {HTMLElement} params.cards element that contains the cards
 * @param {(action: string, id: string) => void} params.onAction
 */
export function createCardMenu({ menu, cards, onAction }) {
  let targetId = "";
  menu.innerHTML = MENU_ITEMS.map((item) => `<button type="button" role="menuitem" class="card-menu-item${item.danger ? " danger" : ""}" data-menu-action="${item.action}"><span>${t(item.label)}</span><small>${t(item.hint)}</small></button>`).join("");
  const items = () => [...menu.querySelectorAll(".card-menu-item")];

  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    cards.querySelector(".bookmark-card.menu-open")?.classList.remove("menu-open");
  }

  function openAt(card, x, y) {
    close();
    targetId = card.dataset.id || "";
    if (!targetId) return;
    card.classList.add("menu-open");
    menu.hidden = false;
    const { offsetWidth: width, offsetHeight: height } = menu;
    menu.style.left = `${Math.max(MENU_MARGIN, Math.min(x, window.innerWidth - width - MENU_MARGIN))}px`;
    menu.style.top = `${Math.max(MENU_MARGIN, Math.min(y, window.innerHeight - height - MENU_MARGIN))}px`;
    items()[0]?.focus();
  }

  cards.addEventListener("contextmenu", (event) => {
    const card = event.target.closest(".bookmark-card");
    if (!card) return;
    event.preventDefault();
    openAt(card, event.clientX, event.clientY);
  });
  cards.addEventListener("click", (event) => {
    const trigger = event.target.closest(".card-more");
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    const box = trigger.getBoundingClientRect();
    openAt(trigger.closest(".bookmark-card"), box.left, box.bottom + 4);
  });
  menu.addEventListener("click", (event) => {
    const action = event.target.closest("[data-menu-action]")?.dataset.menuAction;
    if (!action) return;
    const id = targetId;
    close();
    onAction(action, id);
  });
  menu.addEventListener("keydown", (event) => {
    const list = items();
    const index = list.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    }
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target)) close();
  });
  window.addEventListener("scroll", close, { passive: true });
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);

  return { close };
}

/**
 * @param {object} params
 * @param {HTMLDialogElement} params.dialog
 * @param {(id: string, values: { title: string, note: string }) => Promise<void>} params.onSave
 */
export function createEditDialog({ dialog, onSave }) {
  const form = dialog.querySelector("form");
  const title = dialog.querySelector("#editTitle");
  const note = dialog.querySelector("#editNote");
  const error = dialog.querySelector("#editError");
  let currentId = "";

  dialog.querySelector("#editCancel").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      await onSave(currentId, { title: title.value.replace(/\s+/g, " ").trim(), note: note.value.trim() });
      dialog.close();
    } catch (failure) {
      error.textContent = tr`保存失败：${failure.message}`;
    }
  });

  return {
    /** @param {object} record @param {string} shownTitle @param {boolean} hasRealTitle false when shownTitle is only a stand-in */
    open(record, shownTitle, hasRealTitle) {
      currentId = record.id;
      title.value = hasRealTitle ? shownTitle : "";
      title.placeholder = shownTitle;
      note.value = record.note || "";
      error.textContent = "";
      dialog.showModal();
      title.focus();
      title.select();
    },
  };
}

/** A short message with an optional action button, used for "deleted · undo". */
export function createToast(element) {
  let timer;
  let action = null;
  element.addEventListener("click", (event) => {
    if (!event.target.closest("[data-toast-action]") || !action) return;
    const run = action;
    hide();
    run();
  });

  function hide() {
    clearTimeout(timer);
    action = null;
    element.hidden = true;
  }

  return {
    /** @param {string} message @param {{ label: string, run: () => void }} [button] */
    show(message, button) {
      clearTimeout(timer);
      action = button?.run || null;
      element.replaceChildren();
      const text = document.createElement("span");
      text.textContent = message;
      element.append(text);
      if (button) {
        const control = document.createElement("button");
        control.type = "button";
        control.dataset.toastAction = "1";
        control.textContent = button.label;
        element.append(control);
      }
      element.hidden = false;
      timer = setTimeout(hide, TOAST_DURATION_MS);
    },
    hide,
  };
}

/** Saves text as a file through the browser's normal download flow. */
export function downloadTextFile(filename, text, mimeType = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
