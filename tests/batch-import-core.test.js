import test from "node:test";
import assert from "node:assert/strict";
import { prepareImportBatch } from "../src/batch-import-core.js";

test("import batches deduplicate IDs and retain cover candidates without post body", () => {
  const records = prepareImportBatch([
    { id: "1", url: "https://x.com/a/status/1", title: "标题", text: "正文", imageUrls: ["https://pbs.twimg.com/media/a", "https://pbs.twimg.com/media/b"] },
    { id: "1", title: "重复" },
    { title: "没有 ID" },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, "标题");
  assert.equal(records[0].text, "");
  assert.deepEqual(records[0].imageUrls, ["https://pbs.twimg.com/media/a", "https://pbs.twimg.com/media/b"]);
});
