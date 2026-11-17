// Lists every Chinese string that needs an English entry in src/i18n-en.js:
// strings passed to t(), tr`` templates, static page text, and messages produced by scripts
// that run inside X pages (those cannot import the translation helpers).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CJK = /[一-鿿]/;
const PAGE_SCRIPTS = ["content.js", "page-hook.js", "api-bridge.js", "title-reader.js", "article-reader.js", "detail-reader.js"];
const UNUSED = ["file-system.js", "semantic-search.js", "semantic-worker.js", "semantic-worker.bundle.js"];
const MENU_FILE = "card-actions.js";

function unquote(literal) {
  return JSON.parse(literal);
}

function templateKeyOf(body) {
  let key = "";
  let index = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "$" && body[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < body.length && depth > 0) {
        if (body[i] === "{") depth += 1;
        if (body[i] === "}") depth -= 1;
        i += 1;
      }
      i -= 1;
      key += `{${index}}`;
      index += 1;
    } else {
      key += body[i];
    }
  }
  return key;
}

function templateBodies(source) {
  const bodies = [];
  for (let i = 0; i < source.length - 2; i += 1) {
    if (source[i] !== "t" || source[i + 1] !== "r" || source[i + 2] !== "`" || /[\w$]/.test(source[i - 1] || "")) continue;
    const stack = ["`"];
    let j = i + 3;
    while (j < source.length && stack.length) {
      const ch = source[j];
      if (stack.at(-1) === "`") {
        if (ch === "\\") j += 1;
        else if (ch === "`") stack.pop();
        else if (ch === "$" && source[j + 1] === "{") { stack.push("{"); j += 1; }
      } else if (ch === "`") stack.push("`");
      else if (ch === "{") stack.push("{");
      else if (ch === "}") stack.pop();
      j += 1;
    }
    bodies.push(source.slice(i + 3, j - 1));
  }
  return bodies;
}

export function collectKeys(root = ROOT) {
  const keys = new Set();
  const scripts = [
    ...readdirSync(join(root, "extension")).filter((name) => name.endsWith(".js") && !UNUSED.includes(name)).map((name) => join(root, "extension", name)),
    ...readdirSync(join(root, "src")).filter((name) => name.endsWith(".js") && !name.startsWith("i18n")).map((name) => join(root, "src", name)),
  ];
  for (const file of scripts) {
    const source = readFileSync(file, "utf8");
    const name = file.split("/").pop();
    for (const match of source.matchAll(/\bt\(\s*("(?:[^"\\\n]|\\.)*")\s*\)/g)) keys.add(unquote(match[1]));
    for (const match of source.matchAll(/\bt\([^()"]*\|\|\s*("(?:[^"\\\n]|\\.)*")\s*\)/g)) keys.add(unquote(match[1]));
    for (const body of templateBodies(source)) keys.add(templateKeyOf(body).replace(/\\n/g, "\n"));
    if (PAGE_SCRIPTS.includes(name)) {
      for (const match of source.matchAll(/(?:error:\s*(?:[^,"`]*\?\s*)?|new Error\()("(?:[^"\\\n]|\\.)*")(?:\s*:\s*("(?:[^"\\\n]|\\.)*"))?/g)) {
        for (const literal of [match[1], match[2]].filter(Boolean)) if (CJK.test(literal)) keys.add(unquote(literal));
      }
    }
    if (name === MENU_FILE) {
      for (const match of source.matchAll(/(?:label|hint):\s*("(?:[^"\\\n]|\\.)*")/g)) keys.add(unquote(match[1]));
    }
  }
  for (const page of ["popup.html", "manager.html"]) {
    const html = readFileSync(join(root, "extension", page), "utf8");
    for (const match of html.matchAll(/>([^<>]+)</g)) if (CJK.test(match[1])) keys.add(match[1].trim());
    for (const match of html.matchAll(/\s(?:title|placeholder|aria-label)="([^"]+)"/g)) if (CJK.test(match[1])) keys.add(match[1]);
  }
  return [...keys].filter((key) => /[\u3000-\u9fff\uff00-\uffef]/.test(key)).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(`${JSON.stringify(collectKeys(), null, 1)}\n`);
