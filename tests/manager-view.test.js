import test from "node:test";
import assert from "node:assert/strict";
import { cardTemplate } from "../extension/manager-view.js";

const record = { id: "1", author: "bob", title: 'A "quoted" title', url: "https://x.com/bob/status/1", imageUrls: ["https://pbs.twimg.com/media/abc.jpg"] };

test("the cover link can take focus when clicked, so it is named instead of hidden from assistive technology", () => {
  const link = cardTemplate(record).match(/<a class="card-image-link"[^>]*>/)[0];
  assert.doesNotMatch(link, /aria-hidden/);
  assert.match(link, /aria-label="A &quot;quoted&quot; title"/);
  assert.match(link, /tabindex="-1"/);
});

test("a card without images has no cover link", () => {
  assert.doesNotMatch(cardTemplate({ ...record, imageUrls: [] }), /card-image-link/);
});

test("author options show the nickname with the handle, or just the handle when no nickname is known", async () => {
  const { authorLabel } = await import("../extension/author-picker.js");
  const named = authorLabel({ author: "alice", name: "<Alice> 爱丽丝" });
  assert.match(named, /class="author-name">&lt;Alice&gt; 爱丽丝</);
  assert.match(named, /class="author-handle">@alice</);
  const plain = authorLabel({ author: "bob" });
  assert.match(plain, /class="author-name">@bob</);
  assert.doesNotMatch(plain, /author-handle/);
});
