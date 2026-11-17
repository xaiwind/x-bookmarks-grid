# Local Semantic Search Implementation Plan

> **For agentic workers:** Implement inline in this session. This checkout has no Git metadata, so worktrees and commits are unavailable.

**Goal:** Add optional, multilingual semantic search over the local bookmark library without sending bookmark content or queries to an AI service.

**Architecture:** Bundle Transformers.js and ONNX Runtime into an extension-owned module worker. Download pinned model data only after user consent, cache it in extension Cache Storage, and store per-record vectors in the existing IndexedDB database. Keep lexical search available and combine rankings only when semantic indexing succeeds.

**Tech Stack:** Chrome MV3, JavaScript ES modules, IndexedDB, Cache Storage, Transformers.js, ONNX Runtime Web, esbuild, Node `node:test`.

## Global Constraints

- Model: `Xenova/multilingual-e5-small`, pinned to revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`.
- User-initiated first download is approximately 136 MB; do not download model weights during install, normal startup, or default tests.
- Keep all inference in an extension Web Worker; disable remote model loading for every query after the explicit download flow.
- Use E5 prefixes `passage:` for record text and `query:` for search text; record the 512-token input limit in UI/help text.
- Preserve the existing keyword search path as the deterministic fallback.
- No API key, server, telemetry, or remote JavaScript/WASM execution.

---

### Task 1: Package and bundle local inference runtime

**Files:**
- Modify: `package.json` — add pinned Transformers.js and esbuild development/build dependencies and a semantic worker build script.
- Create: `extension/semantic-worker.js` — module worker entry for embedding and model download progress.
- Create (generated): `extension/semantic-worker.bundle.js` — bundled local runtime loaded by the extension.
- Modify: `manifest.json` — add local storage capacity and only the model host permissions needed for explicit download.

**Interfaces:** Worker messages are `{ id, type, payload }`; responses are `{ id, type, payload }` and progress uses `{ id, type: "progress", phase, loaded, total }`.

- [x] Pin package versions in `package.json`; run `pnpm install` to create the lockfile.
- [x] Bundle the worker for browser execution and configure ONNX WASM paths to extension-local assets.
- [x] Pin the model revision; configure Cache Storage and WASM caching; provide download, embedding, and cancellation through worker lifetime control.
- [x] Default remote model loading off; permit model downloads only during the explicit download request.
- [x] Confirm build output packages runtime code locally while leaving model weights outside the extension bundle.

### Task 2: Semantic data store and deterministic ranking helpers

**Files:**
- Modify: `extension/idb.js` — upgrade database to add an `embeddings` object store keyed by record ID.
- Modify: `extension/bookmark-repository.js` — read/write/delete embedding rows and clear the semantic store.
- Modify: `src/library-core.js` — build canonical document text/fingerprint and fuse lexical and semantic rankings.
- Modify: `tests/library-core.test.js` — cover fingerprint stability, changed-record invalidation, and deterministic rank fusion.

**Interfaces:**
- `createSemanticDocument(record, projectNames) -> { text, fingerprint }`
- `mergeSearchRankings(lexicalRecords, semanticRecords, k = 60) -> Record[]`
- `getEmbedding(id) -> Promise<Embedding | null>`
- `putEmbeddings(rows) -> Promise<void>`
- Embedding rows are `{ id, fingerprint, vector: number[], modelRevision: string, updatedAt: string }`.

- [x] Create the store during upgrade without altering existing records, seen IDs, projects, or vault handles.
- [x] Build document text from title, author, body, links, project names, note, reason, and use case; add `passage:` prefix.
- [x] Fingerprint document text plus model revision so only changed records are re-embedded.
- [x] Fuse lexical and semantic order using reciprocal rank fusion with stable ID tie-breaks; keep existing filters.
- [x] Add Node tests for stable fingerprints, annotation changes, duplicate rank entries, and deterministic ties.

### Task 3: Worker client, consent, download, and lifecycle

**Files:**
- Create: `extension/semantic-search.js` — worker client, consent/settings state, cache lifecycle, indexing orchestration.
- Modify: `extension/manager.html` — semantic mode, model download, progress, cancel, reindex, and remove controls.
- Modify: `extension/manager.js` — search mode integration and state display.
- Modify: `extension/styles.css` — semantic controls and progress styling.
- Modify: `extension/bookmark-repository.js` — methods needed for deleting semantic index rows.

- [x] On manager startup, inspect local consent/index state only; do not initialize the model or make model network requests.
- [x] On explicit opt-in, persist consent, create a Worker, download the pinned model with visible progress, and cancel by terminating the Worker.
- [x] Query and embedding operations run with remote model fetching disabled; use Cache Storage only.
- [x] On enable, compare record fingerprints and embed missing/changed records in bounded batches, persisting each completed batch.
- [x] On remove, terminate workers, clear vectors and the named model/WASM caches, and clear consent and semantic state.
- [x] On worker/model/index errors, show a local-search fallback message and keep the lexical search path usable.

### Task 4: Hybrid search and documentation

**Files:**
- Modify: `extension/manager.js` — compute lexical rank, obtain semantic rank, fuse, then apply current filters.
- Modify: `README.md` — document first download size, local-only behavior, fallback, storage, and known truncation limit.
- Modify: `docs/superpowers/plans/2026-10-29-local-semantic-search.md` — record completed steps.

- [x] In semantic mode, combine semantic and lexical candidates, then apply non-query filters.
- [x] In keyword mode or when no index/model is available, use keyword results unchanged.
- [x] Add helper tests without requiring model downloads in `npm test`.
- [x] Run `npm test` and `pnpm build:semantic-worker`; inspect the manifest and bundle paths for missing runtime assets.

## Self-Review

- Spec coverage: local model and explicit download (Tasks 1 and 3); local-only vectors and incremental reindex (Tasks 2 and 3); hybrid cross-language retrieval and fallback (Tasks 2 and 4); consent, cancellation, and deletion (Task 3); size and truncation disclosure (Task 4).
- All model data identifiers and store fields are consistent across tasks.
- Default tests never fetch the model; model integration remains a separate manual browser check.
