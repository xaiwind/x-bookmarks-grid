import { env, pipeline } from "@huggingface/transformers";

const MODEL = "Xenova/multilingual-e5-small";
const REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const CACHE_KEY = "x-bookmark-semantic-v1";
let extractorPromise;

env.cacheKey = CACHE_KEY;
env.useBrowserCache = true;
env.useWasmCache = true;
env.allowLocalModels = false;
const wasmBase = new URL("./vendor/semantic/", self.location.href).href;
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${wasmBase}ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${wasmBase}ort-wasm-simd-threaded.asyncify.wasm`,
};

self.addEventListener("message", async (event) => {
  const { id, type, payload = {} } = event.data || {};
  try {
    if (type === "cancel") return;
    if (type === "download") {
      env.allowRemoteModels = true;
      await getExtractor((progress) => self.postMessage({ id, type: "progress", ...progress }));
      env.allowRemoteModels = false;
      self.postMessage({ id, type: "complete", payload: { revision: REVISION } });
      return;
    }
    env.allowRemoteModels = false;
    const extractor = await getExtractor();
    const texts = type === "embed" ? payload.texts : [payload.text];
    const vectors = await extractor(texts, { pooling: "mean", normalize: true, truncation: true });
    self.postMessage({ id, type: "complete", payload: { vectors: vectors.tolist(), revision: REVISION } });
  } catch (error) {
    env.allowRemoteModels = false;
    self.postMessage({ id, type: "error", payload: { message: error?.message || String(error) } });
  }
});

function getExtractor(progress_callback) {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL, {
      revision: REVISION,
      dtype: "q8",
      progress_callback,
    }).catch((error) => {
      extractorPromise = null;
      throw error;
    });
  }
  return extractorPromise;
}
