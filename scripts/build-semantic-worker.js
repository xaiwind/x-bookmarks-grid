import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transformersEntry = createRequire(import.meta.url).resolve("@huggingface/transformers");
const requireFromTransformers = createRequire(transformersEntry);
const runtimeEntry = requireFromTransformers.resolve("onnxruntime-web");
const runtimeDir = path.dirname(runtimeEntry);
const outputDir = path.join(root, "extension", "vendor", "semantic");

await mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "extension", "semantic-worker.js")],
  outfile: path.join(root, "extension", "semantic-worker.bundle.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  minify: true,
  sourcemap: false,
  loader: { ".wasm": "empty" },
});

for (const extension of ["mjs", "wasm"]) {
  const filename = `ort-wasm-simd-threaded.asyncify.${extension}`;
  await copyFile(path.join(runtimeDir, filename), path.join(outputDir, filename));
}

console.log("Built extension/semantic-worker.bundle.js and local ONNX WASM assets.");
