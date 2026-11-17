import test from "node:test";
import assert from "node:assert/strict";
import { buildBackup, mergeBackupRecord, parseBackup } from "../src/backup-core.js";

const records = [
  { id: "1", title: "第一条", url: "https://x.com/a/status/1", imageUrls: ["https://pbs.twimg.com/media/A"], externalUrls: ["https://example.com/"], note: "备注", hidden: true, text: "不该导出" },
  { id: "2", title: "第二条", url: "https://x.com/b/status/2", imageUrls: [], externalUrls: [] },
];

test("a backup round-trips every record, including hidden ones, without post bodies", () => {
  const text = buildBackup([...records, { title: "没有 id" }], new Date("2026-11-16T00:00:00Z"));
  const parsed = parseBackup(text);
  assert.equal(parsed.exportedAt, "2026-11-16T00:00:00.000Z");
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(parsed.records.map((record) => record.id), ["1", "2"]);
  assert.deepEqual({ note: parsed.records[0].note, hidden: parsed.records[0].hidden, text: parsed.records[0].text }, { note: "备注", hidden: true, text: "" });
});

test("files that are not backups are rejected with a clear reason", () => {
  assert.throws(() => parseBackup(""), /空的/);
  assert.throws(() => parseBackup("<html>"), /不是 JSON/);
  assert.throws(() => parseBackup(JSON.stringify({ records: [] })), /不是本插件/);
  assert.throws(() => parseBackup(JSON.stringify({ format: "x-bookmark-library-backup", version: 99, records: [] })), /更新的版本/);
});

test("untrusted records are dropped or cleaned on import", () => {
  const text = JSON.stringify({ format: "x-bookmark-library-backup", version: 1, records: [
    { id: "5", title: "ok", url: "javascript:alert(1)", imageUrls: ["https://evil.example/x.png", "https://pbs.twimg.com/media/B"], externalUrls: ["javascript:x", "https://ok.example/"], text: "正文" },
    { id: "../etc" }, null, [], "text", { id: "5", title: "重复的后者生效", url: "https://x.com/a/status/5" },
  ] });
  const parsed = parseBackup(text);
  assert.equal(parsed.skipped, 5);
  assert.deepEqual(parsed.records, [{ id: "5", title: "重复的后者生效", url: "https://x.com/a/status/5", imageUrls: [], externalUrls: [], text: "" }]);
});

test("importing fills gaps but never replaces what the library already has", () => {
  const merged = mergeBackupRecord({ id: "1", title: "现有标题", note: "", imageUrls: [], hidden: false }, { id: "1", title: "备份标题", note: "备份备注", imageUrls: ["a"], hidden: true, category: "设计" });
  assert.deepEqual(merged, { id: "1", title: "现有标题", note: "备份备注", imageUrls: ["a"], hidden: false, category: "设计" });
  assert.deepEqual(mergeBackupRecord(undefined, { id: "2", title: "新" }), { id: "2", title: "新" });
});
