import { t, tr } from "../src/i18n.js";
import { describeDownloadMark } from "../src/download-core.js";

// Asks what to do when a post that was already downloaded is downloaded again.

/**
 * @typedef {{ action: "overwrite" | "copy" | "save", remember: boolean }} DuplicateChoice
 */

/** @param {HTMLDialogElement} dialog */
export function createDuplicateDialog(dialog) {
  const $ = (selector) => dialog.querySelector(selector);
  const ui = {
    title: $("#duplicateTitle"), when: $("#duplicateWhen"), where: $("#duplicateWhere"), note: $("#duplicateNote"),
    overwrite: $("#duplicateOverwrite"), copy: $("#duplicateCopy"), again: $("#duplicateAgain"), cancel: $("#duplicateCancel"),
    remember: $("#duplicateRemember"),
  };
  let settle = null;

  const choose = (action) => () => finish({ action, remember: ui.remember.checked && action !== "save" });
  ui.overwrite.addEventListener("click", choose("overwrite"));
  ui.copy.addEventListener("click", choose("copy"));
  ui.again.addEventListener("click", choose("save"));
  ui.cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => finish(null));

  function finish(choice) {
    if (!settle) return;
    const resolve = settle;
    settle = null;
    if (dialog.open) dialog.close();
    resolve(choice);
  }

  /**
   * @param {{ record: object, title: string, target: "folder" | "browser", fileExists: boolean }} params
   * @returns {Promise<DuplicateChoice | null>} null when cancelled
   */
  function ask({ record, title, target, fileExists }) {
    finish(null);
    const { when, location } = describeDownloadMark(record);
    const canReplace = target === "folder" && fileExists;
    ui.title.textContent = title;
    ui.when.textContent = when ? tr`上次下载：${when}` : t("之前下载过这篇");
    ui.where.textContent = location;
    ui.where.hidden = !location;
    ui.note.textContent = canReplace
      ? t("覆盖会把旧文件更新为最新内容；另存一份会保留旧文件，新文件名后加编号。")
      : target === "folder"
        ? t("上次的文件不在当前文件夹里（可能已移动、删除，或换过下载位置），可以直接重新下载。")
        : t("浏览器会自动给重复的文件名加编号。");
    ui.overwrite.hidden = !canReplace;
    ui.copy.hidden = !canReplace;
    ui.again.hidden = canReplace;
    ui.remember.checked = false;
    ui.remember.closest("label").hidden = !canReplace;
    dialog.showModal();
    (canReplace ? ui.overwrite : ui.again).focus();
    return new Promise((resolve) => { settle = resolve; });
  }

  return { ask };
}
