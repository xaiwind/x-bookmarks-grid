const TEXT_FIELDS = ["title", "text", "author", "url", "note", "reason", "useCase"];

export async function createSemanticDocument(record, projectNames = [], modelRevision = "") {
  const parts = [
    `title: ${record.title || ""}`,
    `author: ${record.author || ""}`,
    `content: ${record.text || ""}`,
    `links: ${(record.externalUrls || []).join(" ")}`,
    `projects: ${projectNames.join(", ")}`,
    `note: ${record.note || ""}`,
    `reason: ${record.reason || ""}`,
    `use case: ${record.useCase || ""}`,
  ];
  const text = `passage: ${parts.join("\n")}`.trim();
  const bytes = new TextEncoder().encode(`${modelRevision}\n${text}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { text, fingerprint };
}

export function cosineSimilarity(left, right) {
  if (!left?.length || left.length !== right?.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function mergeSearchRankings(lexicalRecords, semanticRecords, k = 60) {
  const recordsById = new Map();
  const scores = new Map();
  for (const [rank, record] of lexicalRecords.entries()) {
    if (!record?.id) continue;
    recordsById.set(record.id, record);
    scores.set(record.id, (scores.get(record.id) || 0) + 1 / (k + rank + 1));
  }
  for (const [rank, record] of semanticRecords.entries()) {
    if (!record?.id) continue;
    recordsById.set(record.id, record);
    scores.set(record.id, (scores.get(record.id) || 0) + 1 / (k + rank + 1));
  }
  return [...recordsById.keys()]
    .sort((left, right) => scores.get(right) - scores.get(left) || String(left).localeCompare(String(right)))
    .map((id) => recordsById.get(id));
}

export function filterLibraryRecords(records, filters = {}, projectsById = {}) {
  const query = String(filters.query || "").trim().toLocaleLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const author = String(filters.author || "").trim().toLocaleLowerCase();
  const range = Number(filters.range) || 0;
  const fromDate = filters.fromDate || "";
  const toDate = filters.toDate || "";
  const hasLinks = filters.hasLinks || "";
  const category = filters.category || "";
  const status = filters.status || "";
  const now = filters.now instanceof Date ? filters.now.getTime() : Date.now();

  return records.filter((record) => {
    if (category && record.category !== category) return false;
    if (status && ![record.syncStatus, record.contentStatus, record.articleStatus].includes(status)) return false;
    if (author && !String(record.author || "").toLocaleLowerCase().includes(author)) return false;
    if (hasLinks === "yes" && !(record.externalUrls || []).length) return false;
    if (hasLinks === "no" && (record.externalUrls || []).length) return false;

    const date = Date.parse(record.createdAt || record.syncedAt || "");
    if (range && (!date || now - date > range * 24 * 60 * 60 * 1000 || date > now)) return false;
    if (fromDate || toDate) {
      if (!date) return false;
      const dateKey = toLocalDateKey(new Date(date));
      if (fromDate && dateKey < fromDate) return false;
      if (toDate && dateKey > toDate) return false;
    }

    const projectNames = (record.projectIds || []).map((id) => projectsById[id]?.name || "");
    const haystack = [
      ...TEXT_FIELDS.map((field) => record[field] || ""),
      ...(record.externalUrls || []),
      ...projectNames,
    ].join(" ").toLocaleLowerCase();
    return terms.every((term) => matchesTerm(record, term, haystack));
  });
}

export function mergeImportedRecord(existing = {}, imported = {}) {
  existing ||= {};
  return {
    ...existing,
    ...imported,
    projectIds: [...new Set(existing.projectIds || [])],
    note: existing.note || "",
    reason: existing.reason || "",
    useCase: existing.useCase || "",
  };
}

export function buildLibraryExportMarkdown(records, projectsById = {}, exportedAt = new Date()) {
  const sections = records.map((record) => {
    const title = record.title || `X书签-${record.id || "unknown"}`;
    const projects = (record.projectIds || []).map((id) => projectsById[id]?.name).filter(Boolean);
    const frontmatter = [
      "---",
      `tweet_id: ${yamlString(record.id || "")}`,
      `author: ${yamlString(record.author || "")}`,
      `url: ${yamlString(record.url || "")}`,
      `published: ${yamlString(record.createdAt || "")}`,
      `projects: [${projects.map(yamlString).join(", ")}]`,
      `note: ${yamlString(record.note || "")}`,
      `reason: ${yamlString(record.reason || "")}`,
      `use_case: ${yamlString(record.useCase || "")}`,
      "---",
    ].join("\n");
    const content = [
      frontmatter,
      `# ${escapeMarkdown(title)}`,
      "## 正文",
      record.text || "（未保存正文）",
      "## 外链",
      ...(record.externalUrls || []).map((url) => `- ${url}`),
      "## 图片 URL",
      ...(record.imageUrls || []).map((url) => `- ${url}`),
    ].join("\n\n");
    return content;
  });

  return `${sections.join("\n\n---\n\n")}\n`;
}

export function buildLibraryExportFilename(date = new Date()) {
  const localDate = date instanceof Date ? date : new Date(date);
  const year = localDate.getFullYear();
  const month = String(localDate.getMonth() + 1).padStart(2, "0");
  const day = String(localDate.getDate()).padStart(2, "0");
  return `x-bookmarks-${year}-${month}-${day}.md`;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function toLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function matchesTerm(record, term, haystack) {
  if (term.startsWith("@")) return String(record.author || "").toLocaleLowerCase().includes(term.slice(1));
  if (term.startsWith("category:")) return record.category === term.slice("category:".length);
  if (term.startsWith("status:")) {
    const status = term.slice("status:".length);
    return [record.syncStatus, record.contentStatus, record.articleStatus].includes(status);
  }
  if (term === "downloaded:true") return record.articleStatus === "downloaded";
  if (term === "downloaded:false") return record.articleStatus !== "downloaded";
  return haystack.includes(term);
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}\[\]()#+.!|>~-]/g, "\\$&");
}
