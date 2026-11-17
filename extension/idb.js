import { t, tr } from "../src/i18n.js";

const DB_NAME = "x-bookmarks-to-obsidian";
export const DB_VERSION = 3;
const HANDLE_STORE = "handles";
const RECORD_STORE = "records";
const SEEN_STORE = "seen";
const PROJECT_STORE = "projects";
const EMBEDDING_STORE = "embeddings";

export async function saveDirectoryHandle(handle) {
  const db = await openDb();
  try {
    const transaction = db.transaction(HANDLE_STORE, "readwrite");
    transaction.objectStore(HANDLE_STORE).put(handle, "vault");
    await transactionToPromise(transaction);
  } finally {
    db.close();
  }
}

export async function loadDirectoryHandle() {
  const db = await openDb();
  try {
    const handle = await requestToPromise(db.transaction(HANDLE_STORE, "readonly").objectStore(HANDLE_STORE).get("vault"));
    return handle || null;
  } finally {
    db.close();
  }
}

export async function ensureDirectoryPermission(handle) {
  if (!handle) return false;
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        const records = db.createObjectStore(RECORD_STORE, { keyPath: "id" });
        records.createIndex("author", "author", { unique: false });
        records.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(SEEN_STORE)) db.createObjectStore(SEEN_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PROJECT_STORE)) db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(EMBEDDING_STORE)) db.createObjectStore(EMBEDDING_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error(t("数据库升级被其他扩展页面阻止，请关闭其他插件页面后重试。")));
    };
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error(t("IndexedDB 事务失败。")));
    transaction.onabort = () => reject(transaction.error || new Error(t("IndexedDB 事务已中止。")));
  });
}

export { openDb, requestToPromise };
