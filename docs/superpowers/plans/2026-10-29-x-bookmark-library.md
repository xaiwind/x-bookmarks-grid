# X Bookmark Library Implementation Plan

> **For agentic workers:** Implement inline in this session. Worktree setup and commits are unavailable because this checkout has no Git metadata.

**Goal:** Add a local X bookmark library with reliable import status, searchable project annotations, and Markdown export while retaining optional Obsidian mirroring.

**Architecture:** IndexedDB becomes the source of truth for records, seen IDs, and projects. A repository module owns schema and migration. Pure library helpers handle filtering, metadata merges, and export formatting; the manager page owns search and editing; the existing popup/content script retain X collection and report progress.

**Tech Stack:** Chrome Manifest V3, JavaScript ES modules, IndexedDB, `chrome.storage.local`, Node built-in modules already used by the project.

## Global Constraints

- Store bookmark content, seen IDs, and projects in the current extension profile's IndexedDB; do not add a server or external dependency.
- Keep the X page as the import source and preserve the current maximum of 10 full-text items per batch.
- Keep Obsidian vault output optional; a vault write failure must not discard a locally saved record.
- Preserve user project IDs and annotations whenever a duplicate X record refreshes imported fields.
- Do not expand this milestone to semantic search, X bookmark removal/marking, or scheduled sync.
- Add focused Node tests for new shared filtering, merge, and export logic, then run `npm test` as required by the repository guide.

---

### Task 1: IndexedDB library repository and legacy migration

**Files:**
- Modify: `extension/idb.js` — upgrade existing DB schema while retaining the `handles` store.
- Create: `extension/bookmark-repository.js` — typed-by-convention CRUD and migration boundary.
- Modify: `extension/chrome-storage.js` — support deleting legacy `records` and `seen` after verified migration.

**Interfaces:**
- `listRecords() -> Promise<Record[]>`
- `getRecord(id) -> Promise<Record | null>`
- `putRecord(record) -> Promise<void>`
- `putRecords(records) -> Promise<void>`
- `putLibraryEntry(record, seenRecord) -> Promise<void>` atomically persists a record and its dedupe metadata.
- `listSeen() -> Promise<Record<string, SeenRecord>>`
- `putSeen(entries) -> Promise<void>`
- `listProjects() -> Promise<Project[]>`
- `putProject(project) -> Promise<void>`
- `ensureLibraryReady() -> Promise<void>` migrates old storage idempotently before the APIs read data.

- [x] Upgrade the existing database version and create `records` (keyPath `id`, indexes `author`, `createdAt`), `seen` (keyPath `id`), and `projects` (keyPath `id`) stores only when absent; preserve `handles`.
- [x] Wrap request and transaction completion in promises; close database connections after each operation.
- [x] Migrate legacy `records` and `seen` by ID in one idempotent operation; set a migration marker only after all writes complete, then remove old keys.
- [x] Preserve all unknown legacy record properties during migration so future metadata is not dropped.

### Task 2: Pure library behavior

**Files:**
- Create: `src/library-core.js` — query matching, project/annotation merge, Markdown export.
- Modify: `src/core.js` only if shared normalization needs a small reusable helper.
- Create: `tests/library-core.test.js` — filter, merge, and export behavior.

**Interfaces:**
- `filterLibraryRecords(records, filters) -> Record[]`
- `mergeImportedRecord(existing, imported) -> Record`
- `buildLibraryExportMarkdown(records, exportedAt) -> string`
- `buildLibraryExportFilename(date) -> string`

- [x] Implement case-insensitive full-text matching across title, text, author, URL, project names, notes, reasons, and use cases.
- [x] Apply author, date, and external-link filters together; use tweet `createdAt`, falling back to `syncedAt` for older records.
- [x] Merge fresh imported fields while preserving `projectIds`, `note`, `reason`, and `useCase` from the existing record.
- [x] Render one Markdown section per record with escaped YAML/frontmatter values and readable body, external links, image URLs, projects, note, reason, and use case.
- [x] Use `x-bookmarks-YYYY-MM-DD.md` as the export filename.
- [x] Add focused coverage for project/annotation search, combined filters, metadata preservation, and Markdown fields.
- [x] Run `npm test`; all 22 tests pass.

### Task 3: Make import local-first and report progress

**Files:**
- Modify: `extension/content.js` — emit progress during URL and content collection.
- Modify: `extension/popup.js` — write library records through the repository; show progress, coverage, counts, failures, and retry action.
- Modify: `extension/popup.html` — add progress and content-scope UI.
- Modify: `extension/background.js` only if import defaults need initialization.

**Interfaces:**
- Import progress messages include `operationId`, `stage`, `scanned`, `saved`, `duplicates`, and `failed`.
- The popup listens only to progress messages matching the active `operationId`.

- [x] Run `ensureLibraryReady()` before any sync or import reads.
- [x] Treat IndexedDB as the primary save. Mirror to Obsidian only when a directory is selected and permission is granted; report mirror errors independently.
- [x] Persist URL-only records and full-text records with their existing `contentStatus`; retry only failed IDs and preserve annotations on refresh.
- [x] Show scope text: post text, author, URL, publish time, external URL list, and remote image URLs; explain that media binaries and external article bodies are not saved.
- [x] Keep the 10-item full-text batch limit and report how many records remain URL-only.
- [x] Keep a compact retry queue in `chrome.storage.local` with IDs and error messages; retry by rescanning matching posts on the active X bookmarks page.

### Task 4: Projects, annotations, filters, and selection

**Files:**
- Modify: `extension/manager.html` — add author/date/link filters, project controls, selection, and record editor.
- Modify: `extension/manager.js` — load through repository and implement project/annotation updates and selection state.
- Modify: `extension/styles.css` — style added controls and responsive record details.
- Modify: `src/manager-core.js` only if existing display helpers need a small extraction.

**Interfaces:**
- Manager reads `listRecords()` and `listProjects()` from the repository.
- `Record` adds `projectIds: string[]`, `note: string`, `reason: string`, `useCase: string`.
- `Project` is `{ id: string, name: string, createdAt: string }`.

- [x] Add explicit author, start/end date, and has-links filters; combine them with existing category/status/query filters.
- [x] Add project creation, rename, and per-record multi-project assignment.
- [x] Add editable note, reason, and use-case fields, persisting each update to IndexedDB without rewriting other fields.
- [x] Add per-row selection, select-visible, selected count, and export-selected action.
- [x] Escape all user-controlled values before inserting HTML; retain the existing escaping helpers.

### Task 5: Markdown download and user documentation

**Files:**
- Modify: `extension/manager.js` — download the selected-record export as a Blob.
- Modify: `extension/manager.html` — export action and empty-selection feedback.
- Modify: `README.md` — describe local storage, import scope, project annotations, and export workflow.

- [x] Build the export from selected records using `buildLibraryExportMarkdown`.
- [x] Trigger a browser download with the date-based filename and release the object URL afterward.
- [x] Show a clear message when no records are selected; do not create an empty file.
- [x] Document that IndexedDB is local to the Chrome profile and that Obsidian mirroring remains optional.

## Self-Review

- Spec coverage: local-first import and migration (Tasks 1 and 3); progress/retry/content scope (Task 3); search, author/date/link filters (Tasks 2 and 4); projects and notes (Tasks 1, 2, 4); multi-record Markdown export (Tasks 2 and 5); local-only/privacy and docs (Task 5).
- Shared search/merge/export behavior has focused Node coverage and uses the repository's `npm test` command.
- Manual Chrome/X-page verification remains pending because the browser access host is unavailable in this session.
- Data names are consistent: `projectIds`, `note`, `reason`, and `useCase` are preserved by imports and included in exports.
