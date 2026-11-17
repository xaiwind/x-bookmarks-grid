import { createSemanticDocument, mergeSearchRankings, cosineSimilarity } from "../src/library-core.js";
import {
  clearEmbeddings,
  deleteEmbeddings,
  listEmbeddings,
  putEmbeddings,
} from "./bookmark-repository.js";
import { getStorage, removeStorage, setStorage } from "./chrome-storage.js";

export const MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const ENABLED_KEY = "semanticSearchEnabled";
const CACHE_KEY = "x-bookmark-semantic-v1";

export class SemanticSearch {
  constructor(onProgress = () => {}) {
    this.onProgress = onProgress;
    this.worker = null;
    this.pending = new Map();
    this.requestId = 0;
  }

  async status() {
    const storage = await getStorage([ENABLED_KEY]);
    return Boolean(storage[ENABLED_KEY]);
  }

  async enable() {
    await setStorage({ [ENABLED_KEY]: true });
    try {
      await this.request("download", {}, true);
    } catch (error) {
      await setStorage({ [ENABLED_KEY]: false });
      throw error;
    }
  }

  async search(query, records, projects, lexicalRecords) {
    if (!(await this.status()) || !query.trim()) return lexicalRecords;
    const embeddings = await this.syncIndex(records, projects);
    const queryVector = (await this.request("query", { text: `query: ${query}` }))[0];
    const byId = new Map(records.map((record) => [record.id, record]));
    const semantic = embeddings
      .filter((item) => byId.has(item.id))
      .map((item) => ({ record: byId.get(item.id), score: cosineSimilarity(queryVector, item.vector) }))
      .sort((a, b) => b.score - a.score || String(a.record.id).localeCompare(String(b.record.id)))
      .map(({ record }) => record);
    return mergeSearchRankings(lexicalRecords, semantic);
  }

  async syncIndex(records, projects) {
    const [existing, projectsById] = await Promise.all([
      listEmbeddings(),
      Promise.resolve(Object.fromEntries(projects.map((project) => [project.id, project]))),
    ]);
    const indexed = new Map(existing.map((row) => [row.id, row]));
    const documents = [];
    for (const record of records) {
      const names = (record.projectIds || []).map((id) => projectsById[id]?.name).filter(Boolean);
      const document = await createSemanticDocument(record, names, MODEL_REVISION);
      const row = indexed.get(record.id);
      if (row?.fingerprint !== document.fingerprint || row?.modelRevision !== MODEL_REVISION) {
        documents.push({ id: record.id, ...document });
      }
    }
    const validIds = new Set(records.map((record) => record.id));
    const staleIds = existing.filter((row) => !validIds.has(row.id)).map((row) => row.id);
    await deleteEmbeddings(staleIds);

    for (let offset = 0; offset < documents.length; offset += 8) {
      const batch = documents.slice(offset, offset + 8);
      const vectors = await this.request("embed", { texts: batch.map((item) => item.text) });
      const rows = batch.map((item, index) => ({
        id: item.id,
        fingerprint: item.fingerprint,
        vector: vectors[index],
        modelRevision: MODEL_REVISION,
        updatedAt: new Date().toISOString(),
      }));
      await putEmbeddings(rows);
      this.onProgress({ phase: "index", loaded: Math.min(offset + batch.length, documents.length), total: documents.length });
    }
    return listEmbeddings();
  }

  async rebuild(records, projects) {
    await clearEmbeddings();
    return this.syncIndex(records, projects);
  }

  async remove() {
    this.terminate(new Error("语义搜索任务已取消。"));
    await clearEmbeddings();
    await caches.delete(CACHE_KEY);
    await removeStorage([ENABLED_KEY]);
  }

  cancel() {
    this.terminate(new Error("语义搜索任务已取消。"));
  }

  async request(type, payload, downloading = false) {
    const worker = this.getWorker();
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, downloading });
      worker.postMessage({ id, type, payload });
    });
  }

  getWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(chrome.runtime.getURL("extension/semantic-worker.bundle.js"), { type: "module" });
    this.worker.addEventListener("message", (event) => {
      const { id, type, payload } = event.data || {};
      const pending = this.pending.get(id);
      if (!pending) return;
      if (type === "progress") {
        this.onProgress(event.data);
      } else {
        this.pending.delete(id);
        if (type === "error") pending.reject(new Error(payload?.message || "语义模型操作失败。"));
        else pending.resolve(payload?.vectors || payload || []);
      }
    });
    this.worker.addEventListener("error", (event) => this.terminate(new Error(event.message || "语义 Worker 发生错误。")));
    return this.worker;
  }

  terminate(error) {
    this.worker?.terminate();
    this.worker = null;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
