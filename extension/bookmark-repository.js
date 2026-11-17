import { getStorage, removeStorage, setStorage } from "./chrome-storage.js";
import { openDb, requestToPromise, transactionToPromise } from "./idb.js";
import { mergeImportedRecord } from "../src/library-core.js";
import { isRepositionedRecord } from "../src/sync-core.js";
import { t, tr } from "../src/i18n.js";

const RECORDS = "records";
const SEEN = "seen";
const PROJECTS = "projects";
const EMBEDDINGS = "embeddings";
const MIGRATION_KEY = "libraryMigrationVersion";
const MIGRATION_VERSION = 2;

let readyPromise;

export function ensureLibraryReady() {
  if (!readyPromise) {
    readyPromise = migrateLegacyData().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

export async function listRecords() {
  await ensureLibraryReady();
  return readAll(RECORDS);
}

export async function getRecord(id) {
  await ensureLibraryReady();
  return readOne(RECORDS, id);
}

export async function getRecordsByIds(ids) {
  await ensureLibraryReady();
  if (!ids.length) return [];
  const db = await openDb();
  try {
    const transaction = db.transaction(RECORDS, "readonly");
    const store = transaction.objectStore(RECORDS);
    const requests = ids.map((id) => requestToPromise(store.get(id)));
    return (await Promise.all(requests)).filter(Boolean);
  } finally {
    db.close();
  }
}

export async function putRecord(record) {
  await ensureLibraryReady();
  const db = await openDb();
  try {
    const transaction = db.transaction(RECORDS, "readwrite");
    const completion = transactionToPromise(transaction);
    completion.catch(() => {});
    const store = transaction.objectStore(RECORDS);
    const current = await requestToPromise(store.get(record.id));
    store.put(current ? {
      ...current,
      projectIds: [...new Set(record.projectIds || [])],
      note: record.note || "",
      reason: record.reason || "",
      useCase: record.useCase || "",
    } : record);
    await completion;
  } finally {
    db.close();
  }
}

export async function putLibraryEntry(record, seenRecord) {
  await ensureLibraryReady();
  const db = await openDb();
  try {
    const transaction = db.transaction([RECORDS, SEEN], "readwrite");
    const completion = transactionToPromise(transaction);
    completion.catch(() => {});
    const recordStore = transaction.objectStore(RECORDS);
    const seenStore = transaction.objectStore(SEEN);
    const current = await requestToPromise(recordStore.get(record.id));
    const canonical = {
      ...mergeImportedRecord(current, record),
      imageUrls: [...new Set([...(record.imageUrls || []), ...(current?.imageUrls || [])])],
      text: "",
      externalUrls: [...new Set([...(current?.externalUrls || []), ...(record.externalUrls || [])])],
      hasVideo: Boolean(current?.hasVideo || record.hasVideo),
      file: current?.file || record.file || "",
    };
    recordStore.put(canonical);
    seenStore.put(buildSeenEntry(canonical, seenRecord));
    await completion;
  } finally {
    db.close();
  }
}

/**
 * Merges many records in one transaction. Existing rows are only ever merged, never removed.
 * @param {object[]} records
 * @param {(current: object | undefined, incoming: object) => object} merge
 * @returns {Promise<{ added: number, updated: number, refreshed: number }>} refreshed counts existing rows that were re-bookmarked or upgraded
 */
export async function mergeLibraryEntries(records, merge) {
  await ensureLibraryReady();
  const incoming = records.filter((record) => record?.id);
  if (!incoming.length) return { added: 0, updated: 0, refreshed: 0 };
  const db = await openDb();
  try {
    const transaction = db.transaction([RECORDS, SEEN], "readwrite");
    const completion = transactionToPromise(transaction);
    completion.catch(() => {});
    const recordStore = transaction.objectStore(RECORDS);
    const seenStore = transaction.objectStore(SEEN);
    const [currentRecords, currentSeen] = await Promise.all([
      Promise.all(incoming.map((record) => requestToPromise(recordStore.get(record.id)))),
      Promise.all(incoming.map((record) => requestToPromise(seenStore.get(record.id)))),
    ]);
    let added = 0;
    let refreshed = 0;
    incoming.forEach((record, index) => {
      const current = currentRecords[index];
      if (!current) added += 1;
      else if (isRepositionedRecord(current, record)) refreshed += 1;
      const canonical = { ...merge(current, record), id: record.id, text: "" };
      recordStore.put(canonical);
      seenStore.put(buildSeenEntry(canonical, currentSeen[index] || {}));
    });
    await completion;
    return { added, updated: incoming.length - added, refreshed };
  } finally {
    db.close();
  }
}

function buildSeenEntry(canonical, seenRecord = {}) {
  return {
    ...seenRecord,
    id: canonical.id,
    url: canonical.url || seenRecord.url || "",
    author: canonical.author || seenRecord.author || "",
    title: canonical.title || seenRecord.title || "",
    views: canonical.views || seenRecord.views || "",
    category: canonical.category || seenRecord.category || "未分类",
    post_type: canonical.postType || seenRecord.post_type || "",
    file: canonical.file || "",
    sync_status: canonical.syncStatus || seenRecord.sync_status || "indexed",
    content_status: canonical.contentStatus || seenRecord.content_status || "url_only",
    article_status: canonical.articleStatus || seenRecord.article_status || "link_only",
    synced_at: canonical.syncedAt || seenRecord.synced_at || "",
    downloaded_at: canonical.downloadedAt || seenRecord.downloaded_at || null,
  };
}

/**
 * Changes fields of one stored record. Used for edits made by the user in the library page.
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object>} the updated record
 */
export async function patchRecord(id, patch) {
  await ensureLibraryReady();
  const db = await openDb();
  try {
    const transaction = db.transaction(RECORDS, "readwrite");
    const completion = transactionToPromise(transaction);
    completion.catch(() => {});
    const store = transaction.objectStore(RECORDS);
    const current = await requestToPromise(store.get(id));
    if (!current) {
      transaction.abort();
      throw new Error(t("本地没有这条收藏，可能已被删除。"));
    }
    const next = { ...current, ...patch, id: current.id };
    store.put(next);
    await completion;
    return next;
  } finally {
    db.close();
  }
}

export async function putRecords(records) {
  await ensureLibraryReady();
  if (!records.length) return;
  await writeMany(RECORDS, records.filter((record) => record?.id));
}

export async function listSeen() {
  await ensureLibraryReady();
  const entries = await readAll(SEEN);
  return Object.fromEntries(entries.map(({ id, ...value }) => [id, value]));
}

export async function putSeen(seenMap) {
  await ensureLibraryReady();
  const entries = Object.entries(seenMap || {}).map(([id, value]) => ({ ...value, id }));
  if (entries.length) await writeMany(SEEN, entries);
}

export async function listProjects() {
  await ensureLibraryReady();
  return readAll(PROJECTS);
}

export async function putProject(project) {
  await ensureLibraryReady();
  await writeOne(PROJECTS, project);
}

export async function listEmbeddings() {
  await ensureLibraryReady();
  return readAll(EMBEDDINGS);
}

export async function getEmbedding(id) {
  await ensureLibraryReady();
  return readOne(EMBEDDINGS, id);
}

export async function putEmbeddings(rows) {
  await ensureLibraryReady();
  if (rows.length) await writeMany(EMBEDDINGS, rows.filter((row) => row?.id));
}

export async function clearEmbeddings() {
  await ensureLibraryReady();
  await clearStore(EMBEDDINGS);
}

export async function deleteEmbeddings(ids) {
  await ensureLibraryReady();
  if (!ids.length) return;
  const db = await openDb();
  try {
    const transaction = db.transaction(EMBEDDINGS, "readwrite");
    const store = transaction.objectStore(EMBEDDINGS);
    for (const id of ids) store.delete(id);
    await transactionToPromise(transaction);
  } finally {
    db.close();
  }
}

export async function clearRecordsAndSeen() {
  await ensureLibraryReady();
  const db = await openDb();
  try {
    const transaction = db.transaction([RECORDS, SEEN, EMBEDDINGS], "readwrite");
    transaction.objectStore(RECORDS).clear();
    transaction.objectStore(SEEN).clear();
    transaction.objectStore(EMBEDDINGS).clear();
    await transactionToPromise(transaction);
  } finally {
    db.close();
  }
}

export async function replaceLibraryData(records, seenMap) {
  await ensureLibraryReady();
  const db = await openDb();
  try {
    const transaction = db.transaction([RECORDS, SEEN, PROJECTS, EMBEDDINGS], "readwrite");
    const completion = transactionToPromise(transaction);
    completion.catch(() => {});
    const recordsStore = transaction.objectStore(RECORDS);
    const seenStore = transaction.objectStore(SEEN);
    recordsStore.clear();
    seenStore.clear();
    transaction.objectStore(PROJECTS).clear();
    transaction.objectStore(EMBEDDINGS).clear();
    for (const record of records) if (record?.id) recordsStore.put(record);
    for (const [id, value] of Object.entries(seenMap || {})) seenStore.put({ ...value, id });
    await completion;
  } finally {
    db.close();
  }
}

async function clearStore(storeName) {
  const db = await openDb();
  try {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).clear();
    await transactionToPromise(transaction);
  } finally {
    db.close();
  }
}

async function migrateLegacyData() {
  const legacy = await getStorage(["records", "seen", MIGRATION_KEY]);
  const oldVersion = Number(legacy[MIGRATION_KEY]) || 0;
  if (oldVersion >= MIGRATION_VERSION) return;

  if (oldVersion < 1) {
    const records = deduplicateById(Array.isArray(legacy.records) ? legacy.records.filter((record) => record?.id) : []);
    const seen = Object.entries(legacy.seen || {}).map(([id, value]) => ({ ...value, id }));
    await writeMany(RECORDS, records);
    await writeMany(SEEN, seen);

    const [savedRecords, savedSeen] = await Promise.all([readAll(RECORDS), readAll(SEEN)]);
    const savedRecordIds = new Set(savedRecords.map((record) => record.id));
    const savedSeenIds = new Set(savedSeen.map((entry) => entry.id));
    if (records.some((record) => !savedRecordIds.has(record.id)) || seen.some((entry) => !savedSeenIds.has(entry.id))) {
      throw new Error(t("旧收藏数据迁移校验失败，原始数据已保留，请重试。"));
    }

    await removeStorage(["records", "seen"]);
  }

  if (oldVersion < 2) await stripStoredPostBodies();
  await setStorage({ [MIGRATION_KEY]: MIGRATION_VERSION });
}

async function stripStoredPostBodies() {
  const records = await readAll(RECORDS);
  const sanitized = records.map((record) => ({
    ...record,
    title: record.title || String(record.text || "").replace(/\s+/g, " ").trim().slice(0, 90),
    text: "",
    textLength: Number.isFinite(record.textLength) ? record.textLength : [...String(record.text || "").trim()].length,
    contentStatus: "url_only",
  }));
  await writeMany(RECORDS, sanitized);
}

function deduplicateById(records) {
  const byId = new Map();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      continue;
    }
    byId.set(record.id, {
      ...mergeImportedRecord(existing, record),
      projectIds: [...new Set([...(existing.projectIds || []), ...(record.projectIds || [])])],
      note: existing.note || record.note || "",
      reason: existing.reason || record.reason || "",
      useCase: existing.useCase || record.useCase || "",
    });
  }
  return [...byId.values()];
}

async function readAll(storeName) {
  const db = await openDb();
  try {
    return await requestToPromise(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
  } finally {
    db.close();
  }
}

async function readOne(storeName, key) {
  const db = await openDb();
  try {
    return (await requestToPromise(db.transaction(storeName, "readonly").objectStore(storeName).get(key))) || null;
  } finally {
    db.close();
  }
}

async function writeOne(storeName, value) {
  const db = await openDb();
  try {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    await transactionToPromise(transaction);
  } finally {
    db.close();
  }
}

async function writeMany(storeName, values) {
  if (!values.length) return;
  const db = await openDb();
  try {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    for (const value of values) store.put(value);
    await transactionToPromise(transaction);
  } finally {
    db.close();
  }
}
