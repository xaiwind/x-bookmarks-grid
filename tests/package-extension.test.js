import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildStoreManifest, listPackageFiles } from "../scripts/package-extension.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("the store manifest drops the development key and keeps everything else", () => {
  const store = buildStoreManifest({ ...manifest, key: "abc" });
  assert.equal("key" in store, false);
  assert.deepEqual(Object.keys(store), Object.keys(manifest).filter((name) => name !== "key"));
});

test("the package contains every file the manifest and pages load, and nothing personal", () => {
  const files = new Set(listPackageFiles());
  const needed = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts.flatMap((entry) => entry.js), ...Object.values(manifest.icons)];
  for (const file of needed) assert.ok(files.has(file), `${file} is missing from the package`);
  for (const file of files) {
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file);
    assert.doesNotMatch(file, /migration|backup\.json|node_modules|tests\/|semantic|vendor|file-system/);
  }
});

test("every module imported by a packaged file is itself packaged", () => {
  const files = new Set(listPackageFiles());
  for (const file of [...files].filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/^import .* from "(\.[^"]+)";$/gm)) {
      const target = new URL(match[1], new URL(`../${file}`, import.meta.url)).pathname.split("/").slice(-2).join("/");
      assert.ok(files.has(target), `${file} imports ${target}, which is not packaged`);
    }
  }
});

test("the name and description are localised and every locale is packaged", () => {
  const files = new Set(listPackageFiles());
  assert.equal(manifest.default_locale, "en");
  for (const locale of ["en", "zh_CN"]) {
    const path = `_locales/${locale}/messages.json`;
    assert.ok(files.has(path), path);
    const messages = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
    for (const field of [manifest.name, manifest.description, manifest.action.default_title]) {
      const key = field.match(/^__MSG_(\w+)__$/)?.[1];
      assert.ok(key && messages[key]?.message, `${locale} is missing ${field}`);
    }
    assert.ok(messages.extDescription.message.length <= 132, `${locale} description is too long for the store`);
  }
});

test("the manifest asks only for what the extension uses", () => {
  assert.deepEqual(manifest.permissions, ["alarms", "scripting", "storage", "unlimitedStorage"]);
  // X pages, plus the image and video hosts that downloads save media from.
  assert.deepEqual(manifest.host_permissions, ["https://x.com/*", "https://twitter.com/*", "https://pbs.twimg.com/*", "https://video.twimg.com/*"]);
  assert.equal("content_security_policy" in manifest, false);
});

test("files referenced from stylesheets are packaged, and the bundled font ships with its licence", () => {
  const files = new Set(listPackageFiles());
  for (const file of [...files].filter((name) => name.endsWith(".css"))) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/url\(["']?(\.[^"')]+)["']?\)/g)) {
      const target = new URL(match[1], new URL(`../${file}`, import.meta.url)).pathname.split("/").slice(-2).join("/");
      assert.ok(files.has(target), `${file} uses ${target}, which is not packaged`);
    }
  }
  assert.ok(files.has("fonts/manrope-latin.woff2"));
  assert.ok(files.has("fonts/OFL.txt"));
});
