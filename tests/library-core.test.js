import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLibraryExportFilename,
  buildLibraryExportMarkdown,
  createSemanticDocument,
  cosineSimilarity,
  filterLibraryRecords,
  mergeSearchRankings,
  mergeImportedRecord,
} from "../src/library-core.js";
import { getNextScheduledTime } from "../src/auto-sync-core.js";

const records = [
  {
    id: "100",
    title: "Local PDF podcast tool",
    text: "Turn a PDF into a podcast",
    author: "alice",
    url: "https://x.com/alice/status/100",
    createdAt: "2026-10-28T12:00:00.000Z",
    syncedAt: "2026-10-29T12:00:00.000Z",
    externalUrls: ["https://example.com/tool"],
    imageUrls: ["https://pbs.twimg.com/media/image.jpg"],
    category: "AI",
    contentStatus: "content_synced",
    projectIds: ["project-1"],
    note: "Cross-language search reference",
    reason: "Useful for research",
    useCase: "Prototype retrieval",
  },
  {
    id: "200",
    title: "Another saved post",
    text: "No external links here",
    author: "bob",
    url: "https://x.com/bob/status/200",
    syncedAt: "2026-10-27T12:00:00.000Z",
    externalUrls: [],
    imageUrls: [],
    category: "文学",
    contentStatus: "url_only",
  },
];

test("filterLibraryRecords combines author, date, link, project, and note search", () => {
  const result = filterLibraryRecords(records, {
    author: "ALICE",
    fromDate: "2026-10-28",
    toDate: "2026-10-28",
    hasLinks: "yes",
    query: "prototype project alpha",
    now: new Date("2026-10-29T12:00:00.000Z"),
  }, {
    "project-1": { id: "project-1", name: "Project Alpha" },
  });

  assert.deepEqual(result.map((record) => record.id), ["100"]);
});

test("filterLibraryRecords falls back to import time when publish time is absent", () => {
  const result = filterLibraryRecords(records, {
    fromDate: "2026-10-27",
    toDate: "2026-10-27",
  });

  assert.deepEqual(result.map((record) => record.id), ["200"]);
});

test("mergeImportedRecord refreshes imported fields and preserves user organization", () => {
  const merged = mergeImportedRecord(records[0], {
    id: "100",
    title: "Updated title",
    text: "Updated body",
    contentStatus: "content_synced",
  });

  assert.equal(merged.title, "Updated title");
  assert.equal(merged.text, "Updated body");
  assert.deepEqual(merged.projectIds, ["project-1"]);
  assert.equal(merged.note, "Cross-language search reference");
  assert.equal(merged.reason, "Useful for research");
  assert.equal(merged.useCase, "Prototype retrieval");
});

test("buildLibraryExportMarkdown includes tweet content and library annotations", () => {
  const markdown = buildLibraryExportMarkdown([records[0]], {
    "project-1": { id: "project-1", name: "Project Alpha" },
  });

  assert.match(markdown, /author: "alice"/);
  assert.match(markdown, /url: "https:\/\/x\.com\/alice\/status\/100"/);
  assert.match(markdown, /projects: \["Project Alpha"\]/);
  assert.match(markdown, /note: "Cross-language search reference"/);
  assert.match(markdown, /reason: "Useful for research"/);
  assert.match(markdown, /use_case: "Prototype retrieval"/);
  assert.match(markdown, /## 正文\n\nTurn a PDF into a podcast/);
  assert.match(markdown, /https:\/\/example\.com\/tool/);
  assert.match(markdown, /https:\/\/pbs\.twimg\.com\/media\/image\.jpg/);
});

test("buildLibraryExportFilename uses the local date", () => {
  assert.equal(buildLibraryExportFilename(new Date(2026, 2, 2, 12)), "x-bookmarks-2026-03-02.md");
});

test("createSemanticDocument fingerprints normalized content and annotations", async () => {
  const first = await createSemanticDocument(records[0], ["Project Alpha"], "rev1");
  const same = await createSemanticDocument({ ...records[0] }, ["Project Alpha"], "rev1");
  const changed = await createSemanticDocument({ ...records[0], note: "Changed" }, ["Project Alpha"], "rev1");
  const newRevision = await createSemanticDocument(records[0], ["Project Alpha"], "rev2");

  assert.match(first.text, /^passage:/);
  assert.equal(first.fingerprint, same.fingerprint);
  assert.notEqual(first.fingerprint, changed.fingerprint);
  assert.notEqual(first.fingerprint, newRevision.fingerprint);
});

test("cosineSimilarity handles normalized vectors and invalid dimensions", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1], [1, 0]), 0);
});

test("mergeSearchRankings uses reciprocal rank fusion and stable ID ties", () => {
  const lexical = [{ id: "b" }, { id: "a" }];
  const semantic = [{ id: "a" }, { id: "c" }];
  assert.deepEqual(mergeSearchRankings(lexical, semantic).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(mergeSearchRankings(lexical, semantic).map((item) => item.id), ["a", "b", "c"]);
});

test("getNextScheduledTime respects the selected time zone and rolls to tomorrow", () => {
  const now = new Date("2026-10-29T17:30:00.000Z");
  const next = getNextScheduledTime("01:00", "Asia/Taipei", now);
  assert.equal(next.toISOString(), "2026-10-30T17:00:00.000Z");
  assert.equal(getNextScheduledTime("01:00", "bad-zone", now).toISOString(), "2026-10-30T17:00:00.000Z");
});
