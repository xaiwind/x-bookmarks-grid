import { t, tr } from "../src/i18n.js";
import { displayTitle } from "../src/core.js";
import { buildDownloadMark, buildDownloadPath, copyFilename, DOWNLOAD_PREFS_KEY, frontmatterTweetId, formatSavedLocation, normalizeDownloadPrefs, resolveDownloadTarget, resolveDuplicateAction } from "../src/download-core.js";
import { getStorage, setStorage } from "./chrome-storage.js";
import { deleteDirectoryHandle, ensureDirectoryPermission, loadDirectoryHandle, saveDirectoryHandle } from "./idb.js";
import { downloadTextFile } from "./card-actions.js";
import { fileExists, listSiblingNames, readTextStart, removeFile, writeTextFile } from "./folder-files.js";
import { createDuplicateDialog } from "./duplicate-dialog.js";
import { saveLinkedMedia } from "./media-saver.js";

// "下载文章": saves posts straight into a folder the user picked (for example inside an Obsidian
// vault), or through the browser's normal downloads. The first download asks which one; a post
// that was downloaded before asks whether to overwrite it or keep both.

const HANDLE_KEY = "downloadFolder";
// Chrome remembers the last folder per picker id, so the picker reopens where the user left it.
const PICKER_ID = "x-bookmarks-downloads";
const NO_ACCESS = Object.freeze({ ok: false, reason: "" });

const canPickFolder = () => typeof globalThis.showDirectoryPicker === "function";

/**
 * @typedef {{ filename: string, markdown: string, title: string, note: string }} PreparedPost
 * note is extra text for the status line, such as why the body could not be read.
 */

/**
 * @param {object} params
 * @param {HTMLDialogElement} params.dialog location settings dialog
 * @param {HTMLDialogElement} params.duplicateDialog asked when a post was downloaded before
 * @param {HTMLButtonElement} params.chip toolbar button that shows and changes the location
 * @param {(record: object) => Promise<PreparedPost>} params.prepare reads the post and builds the file
 * @param {(record: object, mark: object) => Promise<void>} params.onDownloaded stores the download mark
 * @param {(text: string) => void} params.setStatus
 * @param {{ show: (message: string, button?: { label: string, run: () => void }) => void }} params.toast
 */
export function createPostDownloader({ dialog, duplicateDialog, chip, prepare, onDownloaded, setStatus, toast }) {
  const $ = (selector) => dialog.querySelector(selector);
  const ui = {
    heading: $("#downloadHeading"), intro: $("#downloadIntro"), name: $("#downloadFolderName"), hint: $("#downloadFolderHint"),
    pick: $("#downloadPick"), useBrowser: $("#downloadUseBrowser"), byAuthor: $("#downloadByAuthor"), saveMedia: $("#downloadSaveMedia"), duplicate: $("#downloadDuplicate"),
    unsupported: $("#downloadUnsupported"), error: $("#downloadError"), done: $("#downloadDone"), chipLabel: chip.querySelector("[data-download-label]"),
  };
  const duplicates = createDuplicateDialog(duplicateDialog);
  let prefs = normalizeDownloadPrefs();
  let folder = null;
  let pending = null;
  const inProgress = new Set();

  ui.pick.addEventListener("click", chooseFolder);
  ui.useBrowser.addEventListener("click", () => applyChoice({ mode: "browser" }));
  ui.byAuthor.addEventListener("change", () => updatePrefs({ byAuthor: ui.byAuthor.checked }));
  ui.saveMedia.addEventListener("change", () => updatePrefs({ saveMedia: ui.saveMedia.checked }));
  ui.duplicate.addEventListener("change", () => updatePrefs({ duplicate: ui.duplicate.value }));
  ui.done.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (!pending) return;
    pending = null;
    setStatus(t("已取消下载。"));
  });
  chip.addEventListener("click", openSettings);

  const ready = load();

  async function load() {
    try {
      const [stored, handle] = await Promise.all([getStorage([DOWNLOAD_PREFS_KEY]), canPickFolder() ? loadDirectoryHandle(HANDLE_KEY) : null]);
      prefs = normalizeDownloadPrefs(stored[DOWNLOAD_PREFS_KEY]);
      folder = handle;
    } catch (failure) {
      setStatus(tr`读取下载位置失败，将重新询问：${failure.message}`);
    }
    renderChip();
  }

  function currentTarget() {
    return resolveDownloadTarget({ prefs, hasFolder: Boolean(folder), canPick: canPickFolder() });
  }

  function renderChip() {
    const target = currentTarget();
    ui.chipLabel.textContent = target === "folder" ? folder.name : target === "browser" ? t("浏览器下载") : t("下载位置");
    chip.title = target === "folder" ? tr`下载的文章会保存到「${folder.name}」，点击更换` : t("设置「下载文章」保存到哪个文件夹");
  }

  function renderDialog() {
    const target = currentTarget();
    const supported = canPickFolder();
    ui.heading.textContent = pending ? t("选择文章保存位置") : t("下载位置");
    ui.intro.textContent = pending
      ? t("第一次下载，选一个文件夹（比如 Obsidian 库里的某个目录），以后会直接保存进去，不再询问。")
      : t("「下载文章」生成的 Markdown 会保存到这里，随时可以更换。");
    ui.name.textContent = target === "folder" ? folder.name : target === "browser" ? t("浏览器默认下载目录") : t("还没有选择");
    ui.hint.textContent = target === "folder"
      ? t("直接写入文件夹，不弹下载框。")
      : target === "browser" ? t("文件会出现在浏览器的下载列表里。") : "";
    ui.pick.hidden = !supported;
    ui.pick.textContent = target === "folder" ? t("更换文件夹…") : t("选择文件夹…");
    ui.useBrowser.disabled = target === "browser";
    ui.useBrowser.textContent = target === "browser" ? t("正在使用浏览器下载") : t("改用浏览器默认下载");
    ui.byAuthor.checked = prefs.byAuthor;
    ui.saveMedia.checked = prefs.saveMedia;
    ui.duplicate.value = prefs.duplicate;
    for (const control of [ui.byAuthor, ui.saveMedia, ui.duplicate]) control.closest("label").hidden = !supported;
    ui.unsupported.hidden = supported;
    ui.done.textContent = pending ? t("取消") : t("完成");
  }

  function openDialog(record = null) {
    pending = record;
    ui.error.textContent = "";
    renderDialog();
    if (!dialog.open) dialog.showModal();
    (canPickFolder() ? ui.pick : ui.done).focus();
  }

  function openSettings() {
    ready.then(() => openDialog(null));
  }

  async function chooseFolder() {
    ui.error.textContent = "";
    let handle;
    try {
      handle = await globalThis.showDirectoryPicker({ id: PICKER_ID, mode: "readwrite", ...(folder ? { startIn: folder } : {}) });
    } catch (failure) {
      if (failure?.name !== "AbortError") ui.error.textContent = tr`无法使用这个文件夹：${failure.message}`;
      return;
    }
    try {
      await saveDirectoryHandle(handle, HANDLE_KEY);
      folder = handle;
      await applyChoice({ mode: "folder" });
    } catch (failure) {
      ui.error.textContent = tr`保存下载位置失败：${failure.message}`;
    }
  }

  async function applyChoice(change) {
    try {
      await savePrefs({ ...prefs, ...change });
    } catch (failure) {
      ui.error.textContent = tr`保存下载位置失败：${failure.message}`;
      return;
    }
    if (change.mode === "browser") forgetFolder();
    renderChip();
    renderDialog();
    if (!pending) {
      setStatus(change.mode === "folder" ? tr`以后下载的文章会保存到「${folder.name}」。` : t("以后下载的文章会走浏览器下载。"));
      return;
    }
    const record = pending;
    pending = null;
    dialog.close();
    run(record);
  }

  async function updatePrefs(change) {
    try {
      await savePrefs({ ...prefs, ...change });
    } catch (failure) {
      ui.error.textContent = tr`保存下载位置失败：${failure.message}`;
    }
    renderDialog();
  }

  async function savePrefs(next) {
    prefs = normalizeDownloadPrefs(next);
    await setStorage({ [DOWNLOAD_PREFS_KEY]: prefs });
  }

  function forgetFolder() {
    folder = null;
    deleteDirectoryHandle(HANDLE_KEY).catch((failure) => setStatus(tr`清除旧的下载文件夹失败：${failure.message}`));
  }

  /** Entry point for the card menu. Must run inside the click so Chrome can ask for folder access. */
  async function download(record) {
    await ready;
    if (currentTarget() === "ask") {
      openDialog(record);
      return;
    }
    run(record);
  }

  async function run(record) {
    if (inProgress.has(record.id)) return;
    inProgress.add(record.id);
    try {
      await save(record);
    } finally {
      inProgress.delete(record.id);
    }
  }

  /** The earlier download of this post, if it went into the folder that is selected now. */
  function previousPathInFolder(record) {
    const saved = record.download;
    return saved?.target === "folder" && saved.folder === folder?.name && saved.path ? saved.path : "";
  }

  async function chooseAction(record, access) {
    const previous = access.ok ? previousPathInFolder(record) : "";
    const exists = previous ? await fileExists(folder, previous).catch(() => false) : false;
    const target = access.ok ? "folder" : "browser";
    const action = resolveDuplicateAction({ prefs, record, target, fileExists: exists });
    if (action !== "ask") return { action, previous: exists ? previous : "" };
    const choice = await duplicates.ask({ record, title: displayTitle(record), target, fileExists: exists });
    if (!choice) return null;
    if (choice.remember) await updatePrefs({ duplicate: choice.action });
    return { action: choice.action, previous: exists ? previous : "" };
  }

  async function save(record) {
    // Ask for access before anything slow, while the click still counts as a user action.
    const access = currentTarget() === "folder" ? await requestAccess(folder) : NO_ACCESS;
    const plan = await chooseAction(record, access);
    if (!plan) {
      setStatus(t("已取消下载。"));
      return;
    }
    let file;
    try {
      file = await prepare(record);
    } catch (failure) {
      setStatus(tr`下载失败：${failure.message}`);
      return;
    }
    let reason = access.reason;
    if (access.ok) {
      try {
        const saved = await writeToFolder(record, file, plan);
        const markNote = await markDownloaded(record, { target: "folder", path: saved.path });
        const where = formatSavedLocation(folder.name, saved.path);
        const message = plan.action === "overwrite" ? tr`已覆盖为最新版本：${where}` : plan.action === "copy" ? tr`已另存一份：${where}` : tr`已保存到 ${where}`;
        announce(`${message}${describeMedia(saved.media)}`, `${file.note}${saved.note}${markNote}`, { label: t("更改位置"), run: openSettings });
        return;
      } catch (failure) {
        reason = describeWriteError(failure);
      }
    }
    downloadTextFile(file.filename, file.markdown);
    const markNote = await markDownloaded(record, { target: "browser", path: file.filename });
    if (reason) {
      announce(tr`无法写入文件夹（${reason}），已改用浏览器下载：${file.filename}`, `${file.note}${markNote}`, { label: t("重新选择"), run: openSettings });
    } else {
      announce(tr`已下载：${file.title}`, `${file.note}${markNote}`, canPickFolder() ? { label: t("设置保存文件夹"), run: openSettings } : undefined);
    }
  }

  async function writeToFolder(record, file, { action, previous }) {
    let path = buildDownloadPath(record, file.filename, prefs);
    if (action === "copy") path = await freePath(path, file.filename);
    else if (path !== previous) path = await pathForThisPost(path, file.filename, record.id);
    const media = prefs.saveMedia
      ? await saveLinkedMedia({ folder, notePath: path, markdown: file.markdown, id: record.id, onProgress: (done, total) => setStatus(tr`正在保存图片和视频：${done}/${total}…`) })
      : { markdown: file.markdown, saved: 0, failed: [] };
    await writeTextFile(folder, path, media.markdown);
    // A changed title or author-folder setting gives the post a new path: drop the old copy it replaces.
    if (action !== "overwrite" || !previous || previous === path) return { path, note: "", media };
    try {
      await removeFile(folder, previous);
      return { path, note: "", media };
    } catch (failure) {
      return { path, note: tr`（旧文件 ${previous} 没能删除：${describeWriteError(failure)}）`, media };
    }
  }

  /** The first unused "name (n).md" next to path. */
  async function freePath(path, filename) {
    const taken = await listSiblingNames(folder, path);
    const name = taken.has(filename) ? copyFilename(filename, (candidate) => taken.has(candidate)) : filename;
    return [...path.split("/").slice(0, -1), name].join("/");
  }

  /** File names carry no post id, so a same-titled note of another post is never overwritten. */
  async function pathForThisPost(path, filename, id) {
    if (!(await fileExists(folder, path))) return path;
    const owner = frontmatterTweetId(await readTextStart(folder, path).catch(() => ""));
    return owner === String(id) ? path : freePath(path, filename);
  }

  async function markDownloaded(record, { target, path }) {
    try {
      await onDownloaded(record, buildDownloadMark({ target, folderName: folder?.name || "", path }));
      return "";
    } catch (failure) {
      return tr`（没能标记为已下载：${failure.message}）`;
    }
  }

  function announce(message, note, button) {
    setStatus(note ? `${message}${note}` : message);
    toast.show(message, button);
  }

  return { download, openSettings, ready };
}

function describeMedia({ saved, failed }) {
  if (failed.length) return tr`，${saved} 个图片/视频已存到本地，${failed.length} 个没能保存（保留了网络链接）`;
  return saved ? tr`，含 ${saved} 个图片/视频` : "";
}

async function requestAccess(handle) {
  try {
    return (await ensureDirectoryPermission(handle)) ? { ok: true, reason: "" } : { ok: false, reason: t("没有获得写入权限") };
  } catch (failure) {
    return { ok: false, reason: describeWriteError(failure) };
  }
}

function describeWriteError(failure) {
  if (failure?.name === "NotFoundError") return t("文件夹已被移动或删除");
  if (failure?.name === "NotAllowedError" || failure?.name === "SecurityError") return t("没有获得写入权限");
  if (failure?.name === "QuotaExceededError") return t("磁盘空间不足");
  return failure?.message || t("原因未知");
}
