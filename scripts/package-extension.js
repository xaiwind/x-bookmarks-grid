// Builds the zip to upload to the Chrome Web Store: only the files the extension runs,
// no personal data, tests or development files.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Left over from earlier experiments; nothing loads them.
const UNUSED_EXTENSION_FILES = new Set(["file-system.js", "semantic-search.js", "semantic-worker.js", "semantic-worker.bundle.js"]);
const SHIPPED_EXTENSIONS = /\.(js|html|css)$/;

/**
 * The store assigns the extension's identity itself and rejects a manifest that carries a key.
 * @param {object} manifest
 * @returns {object}
 */
export function buildStoreManifest(manifest) {
  const { key, ...rest } = manifest;
  return rest;
}

/** @returns {string[]} paths, relative to the project root, that belong in the store package */
export function listPackageFiles(root = ROOT) {
  const extension = readdirSync(join(root, "extension"))
    .filter((name) => SHIPPED_EXTENSIONS.test(name) && !UNUSED_EXTENSION_FILES.has(name) && statSync(join(root, "extension", name)).isFile())
    .map((name) => `extension/${name}`);
  const shared = readdirSync(join(root, "src")).filter((name) => name.endsWith(".js")).map((name) => `src/${name}`);
  const icons = readdirSync(join(root, "icons")).filter((name) => name.endsWith(".png")).map((name) => `icons/${name}`);
  const locales = readdirSync(join(root, "_locales")).map((locale) => `_locales/${locale}/messages.json`);
  // The bundled typeface ships with its licence file, as the SIL Open Font License requires.
  const fonts = readdirSync(join(root, "fonts")).filter((name) => /\.(woff2|txt)$/.test(name)).map((name) => `fonts/${name}`);
  return [...extension, ...shared, ...icons, ...locales, ...fonts].sort();
}

function build() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const stage = join(ROOT, "dist", "package");
  const zipPath = join(ROOT, "dist", `x-bookmarks-grid-${manifest.version}.zip`);
  rmSync(stage, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  mkdirSync(stage, { recursive: true });
  for (const file of listPackageFiles()) {
    mkdirSync(dirname(join(stage, file)), { recursive: true });
    cpSync(join(ROOT, file), join(stage, file));
  }
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(buildStoreManifest(manifest), null, 2)}\n`);
  execFileSync("zip", ["-r", "-q", "-X", zipPath, "."], { cwd: stage });
  if (!existsSync(zipPath)) throw new Error("zip was not created");
  process.stdout.write(`Created ${zipPath} (${Math.round(statSync(zipPath).size / 1024)} KB, ${listPackageFiles().length + 1} files)\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
